const mineflayer = require('mineflayer');
const pathfinder = require('mineflayer-pathfinder');
const { GoalFollow, GoalNear } = pathfinder.goals;
const OpenAI = require('openai');
const { Vec3 } = require('vec3');
const net = require('net');

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
if (isNaN(MC_PORT) || MC_PORT < 1 || MC_PORT > 65535) {
  console.error('错误: MC_PORT 必须是 1-65535 之间的数字');
  process.exit(1);
}
if (isNaN(DECISION_INTERVAL) || DECISION_INTERVAL < 100) {
  console.error('错误: DECISION_INTERVAL 必须是 >= 100 的数字（毫秒）');
  process.exit(1);
}

const openai = new OpenAI({
  baseURL: API_URL,
  apiKey: API_KEY,
});

let bot;
let isProcessing = false;
let waitingForPlayer = false;
let decisionInterval = null;
let currentTask = '';
let conversationHistory = [];
let cachedSystemContent = '';
let prevStateSignature = '';
let reconnectTimer = null;
let reconnectAttempts = 0;

function botChat(msg) {
  const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  bot.chat(`[${now}] [${BOT_NAME}] ${msg}`);
}

const ACTION_DEFINITIONS = [
  { name: 'moveTo', description: 'Move to x,y,z', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' } } },
  { name: 'follow', description: 'Follow a player', parameters: { username: { type: 'string', description: 'Player name' } } },
  { name: 'stopFollowing', description: 'Stop following', parameters: {} },
  { name: 'lookAt', description: 'Look at position', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' } } },
  { name: 'chat', description: 'Send chat message', parameters: { message: { type: 'string', description: 'Message text' } } },
  { name: 'mineBlock', description: 'Mine block at x,y,z', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' } } },
  { name: 'placeBlock', description: 'Place a block', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' }, blockName: { type: 'string', description: 'Block type' } } },
  { name: 'equip', description: 'Equip item to hand', parameters: { itemName: { type: 'string', description: 'Item name' } } },
  { name: 'attack', description: 'Attack nearest entity of type', parameters: { entityType: { type: 'string', description: 'Entity type' } } },
  { name: 'collectNearby', description: 'Pick up dropped items nearby', parameters: { range: { type: 'number', description: 'Search range' } } },
  { name: 'goToPlayer', description: 'Go to a player', parameters: { username: { type: 'string', description: 'Player name' } } },
  { name: 'setTask', description: 'Set current task description', parameters: { task: { type: 'string', description: 'Task description' } } },
  { name: 'wait', description: 'Wait N seconds', parameters: { seconds: { type: 'number', description: 'Seconds' } } },
  { name: 'dropItem', description: 'Drop items by name', parameters: { itemName: { type: 'string', description: 'Item name or "all"' } } },
  { name: 'consume', description: 'Eat food to restore hunger', parameters: {} },
  { name: 'sleep', description: 'Sleep in nearby bed', parameters: {} },
  { name: 'activateBlock', description: 'Interact with block', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' } } },
  { name: 'openContainer', description: 'Open chest/furnace/etc', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' } } },
  { name: 'closeContainer', description: 'Close open container', parameters: {} },
  { name: 'withdraw', description: 'Take items from container', parameters: { slot: { type: 'number', description: 'Slot index' }, count: { type: 'number', description: 'Amount' } } },
  { name: 'deposit', description: 'Put items into container', parameters: { itemName: { type: 'string', description: 'Item name' }, count: { type: 'number', description: 'Amount' } } },
  { name: 'craft', description: 'Craft items at table', parameters: { itemName: { type: 'string', description: 'Item to craft' }, count: { type: 'number', description: 'Amount' } } },
  { name: 'farm', description: 'Till and plant seeds', parameters: { x: { type: 'number', description: 'X' }, y: { type: 'number', description: 'Y' }, z: { type: 'number', description: 'Z' }, seedName: { type: 'string', description: 'Seed type' } } },
  { name: 'breedAnimals', description: 'Breed animals with food', parameters: { animalType: { type: 'string', description: 'Animal type' } } },
  { name: 'fish', description: 'Cast fishing rod', parameters: {} },
  { name: 'trade', description: 'Trade with villager', parameters: { tradeIndex: { type: 'number', description: 'Trade slot' }, count: { type: 'number', description: 'Times to trade' } } },
  { name: 'finish', description: 'Reply and wait for player', parameters: { message: { type: 'string', description: 'Reply message' } } },
];

if (CHEAT) {
  ACTION_DEFINITIONS.push({
    name: 'command',
    description: 'Run server command as op',
    parameters: {
      command: { type: 'string', description: 'Command text' },
    },
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  if (decisionInterval) { clearInterval(decisionInterval); decisionInterval = null; }
  reconnectAttempts++;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts - 1), 30000);
  console.log(`[BOT] ${delay / 1000}秒后尝试重连 (第${reconnectAttempts}次)...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    createBot();
  }, delay);
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
    reconnectAttempts = 0;
    startDecisionLoop();
  });

  bot.on('spawn', () => {
    console.log(`[BOT] 出生在 ${bot.entity.position}`);
  });

  bot.on('death', () => {
    console.log('[BOT] 死亡！正在重生...');
    currentTask = '死亡后重生中';
  });

  bot.on('kicked', (reason) => {
    console.log(`[BOT] 被踢出: ${reason}`);
    scheduleReconnect();
  });

  bot.on('error', (err) => {
    console.error(`[BOT] 错误: ${err.message}`);
    if (err.message.includes('connect') || err.message.includes('ECONNREFUSED') || err.message.includes('timeout')) {
      scheduleReconnect();
    }
  });

  bot.on('end', () => {
    console.log('[BOT] 连接已断开');
    scheduleReconnect();
  });

  bot.on('chat', (username, message) => {
    if (username === bot.username) return;
    const now = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    const event = `[${now}] [CHAT] ${username}: ${message}`;
    console.log(event);
    conversationHistory.push({ role: 'user', content: `[${now}] ${username} 说: ${message}` });
    if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
    if (waitingForPlayer) {
      waitingForPlayer = false;
      console.log('[BOT] 玩家发言，继续运行...');
    }
    setImmediate(thinkAndAct);
  });

  bot.on('health', () => {
    if (bot.health <= 4 && Object.keys(bot.players).length > 1) {
      botChat('我需要治疗！');
    }
  });
}

function getState() {
  const entity = bot.entity;
  if (!entity) return { connected: false };

  const pos = entity.position;

  const health = bot.health || 20;
  const food = bot.food || 20;
  const dimension = bot.game.dimension || 'unknown';

  const inventory = bot.inventory ? bot.inventory.items().reduce((acc, i) => {
    acc[i.name] = (acc[i.name] || 0) + i.count;
    return acc;
  }, {}) : {};

  const nearbyEntities = Object.values(bot.entities || {})
    .filter(e => e.type !== 'player' || e.username !== bot.username)
    .filter(e => e.position && entity.position.distanceTo(e.position) < 32)
    .map(e => ({
      name: e.name || e.username || e.type,
      type: e.type,
      dist: Math.round(entity.position.distanceTo(e.position)),
    }))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);

  const nearbyPlayers = Object.values(bot.players || {})
    .filter(p => p.username !== bot.username)
    .map(p => p.username);

  const time = bot.time ? bot.time.timeOfDay : 'unknown';
  const rainState = bot.isRaining ? '下雨' : '晴天';

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

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`操作超时 (${ms}ms)`)), ms);
    }),
  ]);
}

function checkServer(host, port) {
  return new Promise((resolve, reject) => {
    const sock = new net.Socket();
    sock.setTimeout(3000);
    sock.on('connect', () => { sock.destroy(); resolve(); });
    sock.on('error', (e) => { sock.destroy(); reject(e); });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('连接超时')); });
    sock.connect(port, host);
  });
}

async function waitForServer() {
  for (let i = 1; i <= 10; i++) {
    try {
      await checkServer(MC_HOST, MC_PORT);
      console.log(`[BOT] 服务器 ${MC_HOST}:${MC_PORT} 已就绪`);
      return;
    } catch (e) {
      console.log(`[BOT] 等待服务器 ${MC_HOST}:${MC_PORT}... (${i}/10)`);
      if (i === 10) {
        console.error(`[BOT] 服务器 ${MC_HOST}:${MC_PORT} 无法连接，已退出`);
        process.exit(1);
      }
      await sleep(5000);
    }
  }
}

async function executeAction(action) {
  const { name, parameters } = action;

  try {
    switch (name) {
      case 'moveTo': {
        const target = new Vec3(parameters.x, parameters.y, parameters.z);
        const goal = new (require('mineflayer-pathfinder').goals.GoalNear)(target.x, target.y, target.z, 1);
        await withTimeout(bot.pathfinder.goto(goal), 15000);
        return `移动到 (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'follow': {
        const targetPlayer = bot.players[parameters.username];
        if (!targetPlayer || !targetPlayer.entity) {
          return `找不到玩家 ${parameters.username}`;
        }
        const goal = new GoalFollow(targetPlayer.entity, 2);
        bot.pathfinder.setGoal(goal, true);
        bot._followTarget = parameters.username;
        return `正在跟随 ${parameters.username}`;
      }
      case 'stopFollowing': {
        bot.pathfinder.stop();
        bot._followTarget = null;
        return '已停止跟随';
      }
      case 'lookAt': {
        await withTimeout(bot.lookAt(new Vec3(parameters.x, parameters.y, parameters.z)), 5000);
        return `看向 (${parameters.x}, ${parameters.y}, ${parameters.z})`;
      }
      case 'chat': {
        botChat(parameters.message);
        return `说话: ${parameters.message}`;
      }
      case 'mineBlock': {
        const block = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (block && block.name !== 'air') {
          await withTimeout(bot.dig(block), 30000);
          return `挖掘了 ${block.name} 在 (${parameters.x}, ${parameters.y}, ${parameters.z})`;
        }
        return `在 (${parameters.x}, ${parameters.y}, ${parameters.z}) 没有可挖掘的方块`;
      }
      case 'placeBlock': {
        const item = bot.inventory.items().find(i => i.name === parameters.blockName);
        if (!item) return `背包里没有 ${parameters.blockName}`;
        await bot.equip(item, 'hand');
        const targetPos = new Vec3(parameters.x, parameters.y, parameters.z);
        const targetBlock = bot.blockAt(targetPos);
        if (!targetBlock) return `目标位置超出世界范围或未加载`;
        if (targetBlock.name !== 'air') return `目标位置已有方块: ${targetBlock.name}`;
        const refBlock = bot.blockAt(targetPos.offset(0, -1, 0))
          || bot.blockAt(targetPos.offset(0, 0, -1))
          || bot.blockAt(targetPos.offset(1, 0, 0))
          || bot.blockAt(targetPos.offset(-1, 0, 0))
          || bot.blockAt(targetPos.offset(0, 0, 1));
        if (!refBlock || refBlock.name === 'air') return `目标位置附近没有可放置的参考方块`;
        await withTimeout(bot.placeBlock(refBlock), 10000);
        return `放置了 ${parameters.blockName}`;
      }
      case 'equip': {
        const eqItem = bot.inventory.items().find(i => i.name === parameters.itemName)
          || bot.inventory.items().find(i => i.name.includes(parameters.itemName));
        if (!eqItem) return `背包里没有 ${parameters.itemName}`;
        await bot.equip(eqItem, 'hand');
        return `装备了 ${eqItem.name}`;
      }
      case 'attack': {
        const target = Object.values(bot.entities)
          .find(e => (e.name === parameters.entityType || e.type === parameters.entityType) && e.position && bot.entity.position.distanceTo(e.position) < 8);
        if (target) {
          await bot.attack(target);
          return `攻击了 ${parameters.entityType}`;
        }
        return `附近没有 ${parameters.entityType}`;
      }
      case 'collectNearby': {
        const range = parameters.range || 16;
        const items = Object.values(bot.entities)
          .filter(e => e.type === 'object' && e.position && bot.entity.position.distanceTo(e.position) < range);
        let count = 0;
        for (const item of items) {
          try {
            const itemGoal = new (require('mineflayer-pathfinder').goals.GoalNear)(item.position.x, item.position.y, item.position.z, 1);
            await withTimeout(bot.pathfinder.goto(itemGoal), 10000);
            await withTimeout(bot.collect(item), 5000);
            count++;
          } catch (e) { }
        }
        return `捡起了 ${count} 个物品`;
      }
      case 'goToPlayer': {
        const { GoalNear } = require('mineflayer-pathfinder').goals;
        const target = bot.players[parameters.username];
        const pos = target?.entity?.position;
        if (pos) {
          await withTimeout(bot.pathfinder.goto(new GoalNear(pos.x, pos.y, pos.z, 1)), 15000);
          return `已移动到玩家 ${parameters.username} 身边`;
        }
        return `找不到玩家 ${parameters.username}`;
      }
      case 'setTask': {
        currentTask = parameters.task;
        return `任务已设为: ${parameters.task}`;
      }
      case 'wait': {
        await sleep(parameters.seconds * 1000);
        return `等待了 ${parameters.seconds} 秒`;
      }
      case 'dropItem': {
        if (parameters.itemName === 'all') {
          let count = 0;
          for (const item of bot.inventory.items()) {
            await bot.tossStack(item);
            count += item.count;
          }
          return `丢出了 ${count} 个物品`;
        }
        const dropItem = bot.inventory.items().find(i => i.name === parameters.itemName)
          || bot.inventory.items().find(i => i.name.includes(parameters.itemName));
        if (!dropItem) return `背包里没有 ${parameters.itemName} 可以丢弃`;
        await bot.toss(dropItem.type, null, dropItem.count);
        return `丢出了 ${dropItem.count} 个 ${dropItem.name}`;
      }
      case 'consume': {
        const isFood = (item) => bot.registry.foodsArray.some(f => f.id === item.type);
        const food = (bot.heldItem && isFood(bot.heldItem))
          ? bot.heldItem
          : bot.inventory.items().find(isFood);
        if (!food) return '背包里没有食物';
        if (!bot.heldItem || bot.heldItem.type !== food.type) {
          await bot.equip(food, 'hand');
        }
        await withTimeout(bot.consume(), 10000);
        return `吃了 ${food.name}`;
      }
      case 'sleep': {
        const bed = bot.findBlock({ matching: block => block.name.includes('bed'), maxDistance: 6 });
        if (!bed) return '附近没有床';
        await withTimeout(bot.sleep(bed), 10000);
        return '正在睡觉';
      }
      case 'activateBlock': {
        const block = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (!block) return '该位置没有方块';
        await withTimeout(bot.activateBlock(block), 10000);
        return `激活了 ${block.name}`;
      }
      case 'openContainer': {
        const containerBlock = bot.blockAt(new Vec3(parameters.x, parameters.y, parameters.z));
        if (!containerBlock) return '该位置没有方块';
        const container = await withTimeout(bot.openContainer(containerBlock), 10000);
        bot._currentContainer = container;
        return `打开了 ${containerBlock.name}`;
      }
      case 'closeContainer': {
        if (!bot._currentContainer) return '没有打开的容器';
        await bot._currentContainer.close();
        bot._currentContainer = null;
        return '已关闭容器';
      }
      case 'withdraw': {
        if (!bot._currentContainer) return '没有打开的容器';
        const slot = bot._currentContainer.slots[parameters.slot];
        if (!slot) return `槽位 ${parameters.slot} 没有物品`;
        await bot._currentContainer.withdraw(slot.type, null, parameters.count);
        return `取出了 ${parameters.count} 个 ${slot.name}`;
      }
      case 'deposit': {
        if (!bot._currentContainer) return '没有打开的容器';
        const depositItem = bot.inventory.items().find(i => i.name === parameters.itemName);
        if (!depositItem) return `背包里没有 ${parameters.itemName}`;
        await bot._currentContainer.deposit(depositItem.type, null, parameters.count);
        return `存入了 ${parameters.count} 个 ${parameters.itemName}`;
      }
      case 'craft': {
        const craftingTable = bot.findBlock({ matching: block => block.name === 'crafting_table', maxDistance: 6 });
        if (!craftingTable) return '附近没有工作台';
        const itemType = bot.registry.itemsByName[parameters.itemName]?.id;
        if (!itemType) return `未知物品: ${parameters.itemName}`;
        const recipes = bot.recipesFor(itemType, null, 1, true);
        if (!recipes || recipes.length === 0) return `没有 ${parameters.itemName} 的合成配方`;
        await withTimeout(bot.craft(recipes[0], parameters.count || 1, craftingTable), 30000);
        return `合成了 ${parameters.count || 1} 个 ${parameters.itemName}`;
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
          const above = bot.blockAt(new Vec3(parameters.x, parameters.y + 1, parameters.z));
          if (above && above.name === 'air') {
            await bot.activateBlock(soilBlock);
          }
        }
        return `在 (${parameters.x}, ${parameters.y}, ${parameters.z}) 耕种`;
      }
      case 'breedAnimals': {
        const animal = Object.values(bot.entities)
          .find(e => e.name === parameters.animalType && e.position && bot.entity.position.distanceTo(e.position) < 8);
        if (!animal) return `附近没有 ${parameters.animalType}`;
        const foodItem = bot.inventory.items().find(i => i.name.includes('wheat') || i.name.includes('seed'));
        if (foodItem) {
          await bot.equip(foodItem, 'hand');
          await bot.activateEntity(animal);
          return `繁殖了 ${parameters.animalType}`;
        }
        return `没有用于繁殖 ${parameters.animalType} 的食物`;
      }
      case 'fish': {
        const rod = bot.inventory.items().find(i => i.name.includes('fishing_rod'));
        if (!rod) return '没有钓鱼竿';
        await bot.equip(rod, 'hand');
        await withTimeout(bot.fish(), 30000);
        return '钓到了鱼';
      }
      case 'trade': {
        const villager = Object.values(bot.entities).find(e => e.name === 'villager' && e.position && bot.entity.position.distanceTo(e.position) < 6);
        if (!villager) return '附近没有村民';
        const tradeWindow = await bot.openVillager(villager);
        const offer = tradeWindow.trades[parameters.tradeIndex];
        if (!offer) return `没有交易索引 ${parameters.tradeIndex}`;
        for (let i = 0; i < (parameters.count || 1); i++) {
          await tradeWindow.trade(parameters.tradeIndex);
        }
        await tradeWindow.close();
        return `交易了 ${parameters.count || 1} 次`;
      }
      case 'finish': {
        botChat(parameters.message);
        conversationHistory.push({ role: 'assistant', content: parameters.message });
        if (conversationHistory.length > 50) conversationHistory.splice(0, 10);
        return `完成: ${parameters.message}`;
      }
      case 'command': {
        bot.chat('/' + parameters.command.replace(/^\//, ''));
        return `执行命令: ${parameters.command}`;
      }
      default:
        return `未知动作: ${name}`;
    }
  } catch (err) {
    return `动作 ${name} 失败: ${err.message}`;
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

    // 跳过无变化的轮询
    const sig = JSON.stringify({ h: state.health, f: state.food, p: state.position, t: state.currentTask, l: conversationHistory.length });
    if (sig === prevStateSignature) {
      isProcessing = false;
      return;
    }
    prevStateSignature = sig;

    if (!cachedSystemContent) {
      cachedSystemContent = `${BOT_ROLE}

你是一个Minecraft机器人，可以感知世界并执行动作。
你需要基于你的角色、当前状态和周围环境来自主决定下一步做什么。

## 可用动作
${ACTION_DEFINITIONS.map(a => {
  const params = Object.entries(a.parameters).map(([k, v]) => `  - ${k} (${v.type}): ${v.description}`).join('\n');
  return `### ${a.name}\n${a.description}\n参数:\n${params || '  无'}`;
}).join('\n\n')}

## 指令
1. 基于你的角色和当前状态分析情况
2. 决定下一步做什么
3. 请用中文思考和回复。
4. 只输出有效JSON，格式如下：
{"thinking": "...", "actions": [{"name": "动作名称", "parameters": {}}]}
5. 所有返回的动作将同时并行执行。
6. 主动行动 — 根据你的角色做该做的事
7. 注意安全（避开熔岩、悬崖、敌对生物）
8. 检查[结果]历史 — 已经做过的事不要重复做
9. 完成或无任务时，使用 **finish** 回复并等待。
10. 如果玩家只是聊天（不是下达任务），使用 **chat** 后接 **finish**。${CHEAT ? `
11. 只有在玩家要求作弊时才使用 **command**。优先使用普通动作。` : ''}`;
    }

    const messages = [
      { role: 'system', content: cachedSystemContent },
      { role: 'system', content: `## State\n${JSON.stringify(state)}` },
      ...conversationHistory.slice(-10),
    ];

    const response = await openai.chat.completions.create({
      model: API_MODEL,
      messages: messages,
      temperature: 0.7,
      max_tokens: 1600,
      response_format: { type: 'json_object' },
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
      conversationHistory.push({ role: 'system', content: `你刚才输出的JSON格式有误（原始输出: ${content.slice(0, 200)}），无法解析。请只输出纯JSON，不要包含任何其他文字或代码块标记。格式: {"thinking": "...", "actions": [...]}` });
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
        conversationHistory.push({ role: 'system', content: `[结果] ${action.name}: ${result}` });
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
    botChat(`§a=== LLM机器人已上线 ===`);
    botChat(`§e角色: ${BOT_ROLE.replace(/。.*/, '。')}`);
    botChat(`§b输入聊天与我对话，让我帮你做事！`);
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

(async () => {
  await waitForServer();
  createBot();
})();

process.on('SIGINT', () => {
  console.log('\n正在关闭...');
  if (decisionInterval) clearInterval(decisionInterval);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  bot?.quit();
  process.exit(0);
});
