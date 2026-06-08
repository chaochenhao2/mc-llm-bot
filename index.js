const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = pathfinder.goals;
const OpenAI = require('openai');
const { Vec3 } = require('vec3');

let API_URL = process.env.API_URL || 'https://api.openai.com/v1';
API_URL = API_URL.replace(/\/+$/, '');
if (!API_URL.endsWith('/v1')) API_URL += '/v1';
const API_KEY = process.env.API_KEY;
const API_MODEL = process.env.API_MODEL || 'gpt-4o';
const MC_HOST = process.env.MC_HOST || 'localhost';
const MC_PORT = parseInt(process.env.MC_PORT || '25565');
const BOT_NAME = process.env.BOT_NAME || 'LLM_Bot';
const BOT_ROLE = process.env.BOT_ROLE || '你是一个有用的Minecraft助手。帮助玩家进行建筑、探索和生存。请用中文回复。';
const DECISION_INTERVAL = parseInt(process.env.DECISION_INTERVAL || '3000');
const CONTINUOUS = process.env.CONTINUOUS === 'true';
const CHEAT = process.env.CHEAT === 'true';

if (!API_KEY) {
  console.error('错误: 环境变量 API_KEY 是必需的');
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: API_URL,
  apiKey: API_KEY,
});

let bot;
let actionQueue = [];
let isProcessing = false;
let waitingForPlayer = false;
let decisionInterval = null;
let currentTask = '';
let conversationHistory = [];

const ACTION_DEFINITIONS = [
  {
    name: 'moveTo',
    description: 'Move the bot to specified coordinates',
    parameters: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
      z: { type: 'number', description: 'Z coordinate' },
    },
  },
  {
    name: 'follow',
    description: 'Follow a player by username',
    parameters: {
      username: { type: 'string', description: 'Player username to follow' },
    },
  },
  {
    name: 'stopFollowing',
    description: 'Stop following the current target',
    parameters: {},
  },
  {
    name: 'lookAt',
    description: 'Look at a specific position or entity',
    parameters: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
      z: { type: 'number', description: 'Z coordinate' },
    },
  },
  {
    name: 'chat',
    description: 'Send a chat message',
    parameters: {
      message: { type: 'string', description: 'Message to send' },
    },
  },
  {
    name: 'mineBlock',
    description: 'Mine a block at specified coordinates',
    parameters: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
      z: { type: 'number', description: 'Z coordinate' },
    },
  },
  {
    name: 'placeBlock',
    description: 'Place a block from inventory at specified position',
    parameters: {
      x: { type: 'number', description: 'X coordinate' },
      y: { type: 'number', description: 'Y coordinate' },
      z: { type: 'number', description: 'Z coordinate' },
      blockName: { type: 'string', description: 'Block type to place (e.g. dirt, stone, oak_planks)' },
    },
  },
  {
    name: 'equip',
    description: 'Equip an item from inventory',
    parameters: {
      itemName: { type: 'string', description: 'Item name to equip' },
    },
  },
  {
    name: 'attack',
    description: 'Attack the nearest entity of a given type',
    parameters: {
      entityType: { type: 'string', description: 'Entity type to attack (e.g. zombie, spider, player)' },
    },
  },
  {
    name: 'collectNearby',
    description: 'Collect nearby dropped items',
    parameters: {
      range: { type: 'number', description: 'Range to search for items (default: 16)' },
    },
  },
  {
    name: 'goToPlayer',
    description: 'Navigate to a player by username',
    parameters: {
      username: { type: 'string', description: 'Player username to navigate to' },
    },
  },
  {
    name: 'setTask',
    description: 'Set a high-level task describing what you are currently doing',
    parameters: {
      task: { type: 'string', description: 'Description of current task' },
    },
  },
  {
    name: 'wait',
    description: 'Wait/idle for a specified number of seconds',
    parameters: {
      seconds: { type: 'number', description: 'Seconds to wait' },
    },
  },
  {
    name: 'dropItem',
    description: 'Drop items from inventory by name or all items',
    parameters: {
      itemName: { type: 'string', description: 'Item name or "all"' },
    },
  },
  {
    name: 'consume',
    description: 'Eat food to restore hunger',
    parameters: {},
  },
  {
    name: 'sleep',
    description: 'Sleep in a nearby bed if nighttime',
    parameters: {},
  },
  {
    name: 'activateBlock',
    description: 'Interact with a block (door, lever, button, etc.)',
    parameters: {
      x: { type: 'number', description: 'X' },
      y: { type: 'number', description: 'Y' },
      z: { type: 'number', description: 'Z' },
    },
  },
  {
    name: 'openContainer',
    description: 'Open a container (chest, furnace, etc.) at position',
    parameters: {
      x: { type: 'number', description: 'X' },
      y: { type: 'number', description: 'Y' },
      z: { type: 'number', description: 'Z' },
    },
  },
  {
    name: 'closeContainer',
    description: 'Close currently open container',
    parameters: {},
  },
  {
    name: 'withdraw',
    description: 'Withdraw items from an open container slot',
    parameters: {
      slot: { type: 'number', description: 'Container slot index' },
      count: { type: 'number', description: 'Amount to withdraw' },
    },
  },
  {
    name: 'deposit',
    description: 'Deposit items into an open container',
    parameters: {
      itemName: { type: 'string', description: 'Item name to deposit' },
      count: { type: 'number', description: 'Amount to deposit' },
    },
  },
  {
    name: 'craft',
    description: 'Craft items using a crafting table nearby',
    parameters: {
      itemName: { type: 'string', description: 'Item to craft (e.g. crafting_table, furnace)' },
      count: { type: 'number', description: 'Amount to craft' },
    },
  },
  {
    name: 'farm',
    description: 'Till soil and plant seeds at position',
    parameters: {
      x: { type: 'number', description: 'X' },
      y: { type: 'number', description: 'Y' },
      z: { type: 'number', description: 'Z' },
      seedName: { type: 'string', description: 'Seed item name (e.g. wheat_seeds)' },
    },
  },
  {
    name: 'breedAnimals',
    description: 'Breed nearby animals with appropriate food',
    parameters: {
      animalType: { type: 'string', description: 'Animal type (e.g. cow, sheep, chicken)' },
    },
  },
  {
    name: 'fish',
    description: 'Start fishing',
    parameters: {},
  },
  {
    name: 'trade',
    description: 'Trade with a nearby villager using a trade index',
    parameters: {
      tradeIndex: { type: 'number', description: 'Index of the trade offer (0-based)' },
      count: { type: 'number', description: 'How many times to trade' },
    },
  },
  {
    name: 'finish',
    description: 'Tells the player your response and stops decision loop until player speaks again',
    parameters: {
      message: { type: 'string', description: 'Message to say to the player' },
    },
  },
];

if (CHEAT) {
  ACTION_DEFINITIONS.push({
    name: 'command',
    description: 'Execute a server command as operator (use only when necessary)',
    parameters: {
      command: { type: 'string', description: 'Command to execute (e.g. /give @p diamond 10, /gamemode creative @p)' },
    },
  });
}

function createBot() {
  bot = mineflayer.createBot({
    host: MC_HOST,
    port: MC_PORT,
    username: BOT_NAME,
  });

  bot.loadPlugin(pathfinder.pathfinder);

  bot.on('login', () => {
    console.log(`[BOT] 已登录为 ${bot.username}`);
    console.log(`[BOT] 已连接到 ${MC_HOST}:${MC_PORT}`);
    startDecisionLoop();
  });

  bot.on('spawn', () => {
    console.log(`[BOT] 出生在 ${bot.entity.position}`);
  });

  bot.on('death', () => {
    console.log('[BOT] 死亡！正在重生...');
    currentTask = 'Respawning after death';
  });

  bot.on('kicked', (reason) => {
    console.log(`[BOT] 被踢出: ${reason}`);
  });

  bot.on('error', (err) => {
    console.error(`[BOT] 错误: ${err.message}`);
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const event = `[${now}] [CHAT] ${username}: ${message}`;
    console.log(event);
    conversationHistory.push({ role: 'user', content: `[${now}] ${username} says: ${message}` });
    if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
    if (waitingForPlayer) {
      waitingForPlayer = false;
      console.log('[BOT] 玩家发言，继续运行...');
    }
  });

  bot.on('health', () => {
    if (bot.health <= 4) {
      bot.chat('I need healing!');
    }
  });
}

function getState() {
  const entity = bot.entity;
  if (!entity) return { connected: false };

  const pos = entity.position;
  const yaw = entity.yaw;
  const pitch = entity.pitch;

  const health = bot.health || 20;
  const food = bot.food || 20;
  const dimension = bot.game.dimension || 'unknown';

  const inventory = bot.inventory ? bot.inventory.items().map(i => ({
    name: i.name,
    count: i.count,
  })) : [];

  const nearbyEntities = Object.values(bot.entities || {})
    .filter(e => e.type !== 'player' || e.username !== bot.username)
    .filter(e => e.position && entity.position.distanceTo(e.position) < 32)
    .map(e => ({
      name: e.name || e.username || e.type,
      type: e.type,
      distance: Math.round(entity.position.distanceTo(e.position)),
      position: e.position ? { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) } : null,
    }));

  const nearbyPlayers = Object.values(bot.players || {})
    .filter(p => p.username !== bot.username)
    .map(p => ({
      username: p.username,
      ping: p.ping,
    }));

  const time = bot.time ? bot.time.timeOfDay : 'unknown';
  const rainState = bot.isRaining ? 'raining' : 'clear';

  const blockAtFeet = bot.blockAt(entity.position.offset(0, -1, 0));
  const groundBlock = blockAtFeet ? blockAtFeet.name : 'unknown';

  return {
    connected: true,
    position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) },
    health: Math.round(health),
    food: Math.round(food),
    dimension,
    groundBlock,
    time: Math.floor(time),
    weather: rainState,
    inventory,
    entities: nearbyEntities,
    players: nearbyPlayers,
    currentTask,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function executeAction(action) {
  const { name, parameters } = action;

  try {
    switch (name) {
      case 'moveTo': {
        const target = new Vec3(parameters.x, parameters.y, parameters.z);
        const goal = new (require('mineflayer-pathfinder').goals.GoalNear)(target.x, target.y, target.z, 1);
        await bot.pathfinder.goto(goal);
        return `Moved to (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'follow': {
        const targetPlayer = bot.players[parameters.username];
        if (!targetPlayer || !targetPlayer.entity) {
          return `Cannot find player ${parameters.username}`;
        }
        const goal = new GoalFollow(targetPlayer.entity, 2);
        bot.pathfinder.setGoal(goal, true);
        bot._followTarget = parameters.username;
        return `Following ${parameters.username}`;
      }
      case 'stopFollowing': {
        bot.pathfinder.stop();
        bot._followTarget = null;
        return 'Stopped following';
      }
      case 'lookAt': {
        await bot.lookAt(new Vec3(parameters.x, parameters.y, parameters.z));
        return `Looked at (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'chat': {
        bot.chat(parameters.message);
        return `Said: ${parameters.message}`;
      }
      case 'mineBlock': {
        const block = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (block && block.name !== 'air') {
          await bot.dig(block);
          return `Mined ${block.name} at (${parameters.x}, ${parameters.y}, ${parameters.z})`;
        }
        return `No minable block at (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'placeBlock': {
        const item = bot.inventory.items().find(i => i.name === parameters.blockName);
        if (!item) return `No ${parameters.blockName} in inventory`;
        await bot.equip(item, 'hand');
        const targetBlock = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (!targetBlock || targetBlock.name === 'air') {
          await bot.placeBlock(targetBlock || new Vec3(parameters.x, parameters.y, parameters.z));
          return `Placed ${parameters.blockName}`;
        }
        return `Block already exists at target location`;
      }
      case 'equip': {
        const item = bot.inventory.items().find(i => i.name === parameters.itemName);
        if (!item) return `No ${parameters.itemName} in inventory`;
        await bot.equip(item, 'hand');
        return `Equipped ${parameters.itemName}`;
      }
      case 'attack': {
        const target = Object.values(bot.entities)
          .find(e => (e.name === parameters.entityType || e.type === parameters.entityType) && e.position && bot.entity.position.distanceTo(e.position) < 8);
        if (target) {
          await bot.attack(target);
          return `Attacked ${parameters.entityType}`;
        }
        return `No ${parameters.entityType} nearby`;
      }
      case 'collectNearby': {
        const range = parameters.range || 16;
        const items = Object.values(bot.entities)
          .filter(e => e.type === 'object' && e.position && bot.entity.position.distanceTo(e.position) < range);
        let count = 0;
        for (const item of items) {
          try {
            const itemGoal = new (require('mineflayer-pathfinder').goals.GoalNear)(item.position.x, item.position.y, item.position.z, 1);
            await bot.pathfinder.goto(itemGoal);
            await bot.collect(item);
            count++;
          } catch (e) { }
        }
        return `Collected ${count} items`;
      }
      case 'goToPlayer': {
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        const target = bot.players[parameters.username];
        const entity = target?.entity;
        const pos = entity?.position || bot.players[parameters.username]?.entity?.position;
        if (pos) {
          await bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1));
          return `Navigated to ${parameters.username}`;
        }
        return `Cannot find player ${parameters.username}`;
      }
      case 'setTask': {
        currentTask = parameters.task;
        return `Task set to: ${parameters.task}`;
      }
      case 'wait': {
        await sleep(parameters.seconds * 1000);
        return `Waited ${parameters.seconds} seconds`;
      }
      case 'dropItem': {
        if (parameters.itemName === 'all') {
          let count = 0;
          for (const item of bot.inventory.items()) {
            await bot.tossStack(item);
            count += item.count;
          }
          return `Dropped ${count} items`;
        }
        const dropItem = bot.inventory.items().find(i => i.name === parameters.itemName);
        if (!dropItem) return `No ${parameters.itemName} in inventory to drop`;
        await bot.toss(dropItem.type, null, dropItem.count);
        return `Dropped ${dropItem.count} x ${parameters.itemName}`;
      }
      case 'consume': {
        const isFood = (item) => bot.registry.foodsArray.some(f => f.id === item.type);
        const food = (bot.heldItem && isFood(bot.heldItem))
          ? bot.heldItem
          : bot.inventory.items().find(isFood);
        if (!food) return 'No food in inventory';
        if (!bot.heldItem || bot.heldItem.type !== food.type) {
          await bot.equip(food, 'hand');
        }
        await bot.consume();
        return `Ate ${food.name}`;
      }
      case 'sleep': {
        const bed = bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: 6 });
        if (!bed) return 'No bed nearby';
        await bot.sleep(bed);
        return 'Sleeping';
      }
      case 'activateBlock': {
        const block = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (!block) return 'No block at position';
        await bot.activateBlock(block);
        return `Activated ${block.name}`;
      }
      case 'openContainer': {
        const containerBlock = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (!containerBlock) return 'No block at position';
        const container = await bot.openContainer(containerBlock);
        bot._currentContainer = container;
        return `Opened ${containerBlock.name}`;
      }
      case 'closeContainer': {
        if (!bot._currentContainer) return 'No container open';
        await bot._currentContainer.close();
        bot._currentContainer = null;
        return 'Closed container';
      }
      case 'withdraw': {
        if (!bot._currentContainer) return 'No container open';
        const slot = bot._currentContainer.slots[parameters.slot];
        if (!slot) return `No item in slot ${parameters.slot}`;
        await bot._currentContainer.withdraw(slot.type, null, parameters.count);
        return `Withdrew ${parameters.count} x ${slot.name}`;
      }
      case 'deposit': {
        if (!bot._currentContainer) return 'No container open';
        const depositItem = bot.inventory.items().find(i => i.name === parameters.itemName);
        if (!depositItem) return `No ${parameters.itemName} in inventory`;
        await bot._currentContainer.deposit(depositItem.type, null, parameters.count);
        return `Deposited ${parameters.count} x ${parameters.itemName}`;
      }
      case 'craft': {
        const craftingTable = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 6 });
        if (!craftingTable) return 'No crafting table nearby';
        const itemType = bot.registry.itemsByName[parameters.itemName]?.id;
        if (!itemType) return `Unknown item: ${parameters.itemName}`;
        const recipes = bot.recipesFor(itemType, null, 1, true);
        if (!recipes || recipes.length === 0) return `No recipe for ${parameters.itemName}`;
        await bot.craft(recipes[0], parameters.count || 1, craftingTable);
        return `Crafted ${parameters.count || 1} x ${parameters.itemName}`;
      }
      case 'farm': {
        const hoe = bot.inventory.items().find(i => i.name.includes('hoe'));
        if (hoe) await bot.equip(hoe, 'hand');
        const soilBlock = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (soilBlock && soilBlock.name === 'grass_block') {
          await bot.activateBlock(soilBlock);
        }
        const seedItem = bot.inventory.items().find(i => i.name === parameters.seedName);
        if (seedItem) {
          await bot.equip(seedItem, 'hand');
          const above = new Vec3(parameters.x, parameters.y + 1, parameters.z);
          const aboveBlock = bot.blockAt(above);
          if (aboveBlock && aboveBlock.name === 'air') {
            await bot.placeBlock(above);
          }
        }
        return `Farmed at (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'breedAnimals': {
        const animal = Object.values(bot.entities)
          .find(e => e.name === parameters.animalType && e.position && bot.entity.position.distanceTo(e.position) < 8);
        if (!animal) return `No ${parameters.animalType} nearby`;
        const foodItem = bot.inventory.items().find(i => i.name.includes('wheat') || i.name.includes('seed'));
        if (foodItem) {
          await bot.equip(foodItem, 'hand');
          await bot.activateEntity(animal);
          return `Bred ${parameters.animalType}`;
        }
        return `No breeding food for ${parameters.animalType}`;
      }
      case 'fish': {
        const rod = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
        if (!rod) return 'No fishing rod';
        await bot.equip(rod, 'hand');
        await bot.fish();
        return 'Fishing';
      }
      case 'trade': {
        const villager = Object.values(bot.entities).find(e => e.name === 'villager' && e.position && bot.entity.position.distanceTo(e.position) < 6);
        if (!villager) return 'No villager nearby';
        const tradeWindow = await bot.openVillager(villager);
        const offer = tradeWindow.trades[parameters.tradeIndex];
        if (!offer) return `No trade at index ${parameters.tradeIndex}`;
        for (let i = 0; i < (parameters.count || 1); i++) {
          await tradeWindow.trade(parameters.tradeIndex);
        }
        await tradeWindow.close();
        return `Traded ${parameters.count || 1} times`;
      }
      case 'finish': {
        bot.chat(parameters.message);
        conversationHistory.push({ role: 'assistant', content: parameters.message });
        if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
        return `Finished: ${parameters.message}`;
      }
      case 'command': {
        bot.chat('/' + parameters.command.replace(/^\//, ''));
        return `Executed command: ${parameters.command}`;
      }
      default:
        return `Unknown action: ${name}`;
    }
  } catch (err) {
    return `Action ${name} failed: ${err.message}`;
  }
}

async function thinkAndAct() {
  if (isProcessing || (waitingForPlayer && !CONTINUOUS)) return;
  isProcessing = true;
      console.log('[LOOP] 决策循环开始');

  try {
    const state = getState();
    if (!state.connected) {
      isProcessing = false;
      return;
    }

    const systemMessage = {
      role: 'system',
      content: `${BOT_ROLE}

You are a Minecraft bot that can perceive the world and take actions.
You must decide what to do autonomously based on your role, current state, and surroundings.

## Available Actions
${ACTION_DEFINITIONS.map(a => {
  const params = Object.entries(a.parameters).map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`).join('\n');
  return `### ${a.name}\n${a.description}\nParameters:\n${params || '  none'}`;
}).join('\n\n')}

## Your Current State
${JSON.stringify(state, null, 2)}

## Instructions
1. Analyze your current situation based on your role and state
2. Decide what action to take
3. 请用中文思考和回复。
4. You must respond with valid JSON ONLY, no markdown formatting or code blocks. Use this exact format:
{"thinking": "Brief reasoning about what to do and why", "actions": [{"name": "actionName", "parameters": {"key": "value"}}]}
5. You can output multiple actions in one response — all of them will be executed simultaneously in parallel. Use this to combine independent actions.
6. Be proactive - if your role suggests doing something, do it
7. Keep actions simple and safe (avoid lava, cliffs, etc.)
8. Check this history for **[Action]** records - if you have already fulfilled a request, do NOT repeat it. Always check your current inventory to see if the action actually happened.
9. When you have completed the user's request or have nothing to do, use the **finish** action to reply to the player and stop the loop. Do NOT use finish if you still need to take more actions.
10. If the player is just chatting or greeting you (not asking you to do anything), use the **chat** action to respond politely, then **finish** to wait for further instructions.${CHEAT ? `
11. Only use the **command** action when the player asks for cheats or it's absolutely necessary. Prefer normal actions whenever possible.`.trim() : ''}`,
    };

    const messages = [systemMessage, ...conversationHistory.slice(-10)];

    const response = await openai.chat.completions.create({
      model: API_MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1600,
    });

    if (!response.choices || response.choices.length === 0) {
      console.error('[LLM] API 没有返回任何 choices。完整响应:', JSON.stringify(response).slice(0, 500));
      isProcessing = false;
      return;
    }
    const content = response.choices[0]?.message?.content;
    if (!content) {
      isProcessing = false;
      return;
    }

    let decision;
    try {
      decision = JSON.parse(content);
    } catch (e) {
      console.error(`[LLM] 解析响应失败: ${content}`);
      conversationHistory.push({ role: 'user', content: `你刚才输出的JSON格式有误（原始输出: ${content.slice(0, 200)}），无法解析。请只输出纯JSON，不要包含任何其他文字或代码块标记。格式: {"thinking": "...", "actions": [...]}` });
      if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
      isProcessing = false;
      return;
    }

    console.log(`[LLM] ${decision?.thinking || '未提供推理过程'}`);

    if (decision.actions && Array.isArray(decision.actions)) {
      const hasFinish = decision.actions.some(a => a.name === 'finish');
      const nonFinishActions = decision.actions.filter(a => a.name !== 'finish');

      const results = await Promise.all(nonFinishActions.map(async (action) => {
        const result = await executeAction(action);
        console.log(`[动作] ${action.name}: ${result}`);
        conversationHistory.push({ role: 'assistant', content: `[Action] ${action.name}: ${result}` });
        if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
        return { name: action.name, result };
      }));

      if (hasFinish) {
        const finishAction = decision.actions.find(a => a.name === 'finish');
        await executeAction(finishAction);
        if (!CONTINUOUS) {
          waitingForPlayer = true;
          isProcessing = false;
          console.log('[BOT] 等待玩家输入...');
          return;
        }
      }
    }
  } catch (err) {
    console.error(`[LLM] 错误: ${err.message || err}`);
    console.error(`[LLM] 错误堆栈: ${err.stack?.slice(0, 200)}`);
  }

  isProcessing = false;
}

function startDecisionLoop() {
  const start = () => {
    bot.chat('LLM Bot online and ready!');
    decisionInterval = setInterval(thinkAndAct, DECISION_INTERVAL);
    console.log(`[BOT] 决策循环已启动 (continuous: ${CONTINUOUS})`);
    if (!CONTINUOUS) console.log('[BOT] 使用 finish() 来等待玩家输入');
  };

  if (bot.entity) {
    start();
  } else {
    bot.once('spawn', start);
  }
}

console.log('=== LLM Minecraft 机器人 ===');
console.log(`API 地址: ${API_URL}`);
console.log(`模型: ${API_MODEL}`);
console.log(`服务器: ${MC_HOST}:${MC_PORT}`);
console.log(`机器人: ${BOT_NAME}`);
console.log(`角色: ${BOT_ROLE}`);
console.log(`决策间隔: ${DECISION_INTERVAL}ms`);
console.log(`作弊模式: ${CHEAT ? '开（可使用命令动作）' : '关'}`);
console.log(`连续模式: ${CONTINUOUS ? '开（始终运行）' : '关（使用 finish 等待输入）'}`);
console.log('');

createBot();

process.on('SIGINT', () => {
  console.log('\n正在关闭...');
  bot?.quit();
  process.exit(0);
});
