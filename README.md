# LLM Minecraft Bot

由大语言模型驱动的 Minecraft 机器人，能自主感知世界、做出决策并执行动作。

## 功能

- 每 3 秒自动决策
- 感知周围环境：位置、血量、背包、附近实体/玩家、时间、天气
- 聊天交互：记住对话历史
- 丰富动作：移动、跟随、挖掘、放置、合成、耕种、钓鱼、交易等
- 可选的作弊模式：AI 可以执行服务器指令
- 持续模式或按需模式：AI 可以用 `finish` 暂停循环等待玩家说话

## 环境要求

- Node.js 18+
- Minecraft Java Edition 服务器（本地或远程）
- 兼容 OpenAI 的 API Key

## 安装

```bash
cd /root/mc-llm-bot
npm install
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `API_URL` | `https://api.openai.com/v1` | OpenAI 兼容 API 地址 |
| `API_KEY` | (必填) | API 密钥 |
| `API_MODEL` | `gpt-4o` | 模型名称 |
| `MC_HOST` | `localhost` | MC 服务器地址 |
| `MC_PORT` | `25565` | MC 服务器端口 |
| `BOT_NAME` | `LLM_Bot` | 机器人名字 |
| `BOT_ROLE` | (中文助手角色) | 系统提示词 |
| `DECISION_INTERVAL` | `3000` | 决策循环间隔(毫秒) |
| `CONTINUOUS` | `false` | 持续思考模式，设为 `true` 不停调用 API |
| `CHEAT` | `false` | 作弊模式，允许 AI 执行服务器指令 |

## 使用

```bash
export API_KEY=你的API密钥

# 正常模式
node index.js

# 作弊模式（允许 /give、/gamemode 等）
CHEAT=true node index.js

# 持续模式（永不暂停，一直思考）
CONTINUOUS=true node index.js

# 全部开启
CHEAT=true CONTINUOUS=true API_MODEL=auto node index.js
```

## 可用动作

| 动作 | 说明 |
|------|------|
| `moveTo` | 移动到坐标 |
| `follow` | 跟随玩家 |
| `stopFollowing` | 停止跟随 |
| `lookAt` | 看向某个位置 |
| `chat` | 发送聊天消息 |
| `mineBlock` | 挖掘方块 |
| `placeBlock` | 放置方块 |
| `equip` | 装备物品 |
| `attack` | 攻击附近实体 |
| `collectNearby` | 收集掉落物 |
| `goToPlayer` | 导航到玩家位置 |
| `setTask` | 设置当前任务 |
| `wait` | 等待 N 秒 |
| `dropItem` | 丢弃物品 |
| `consume` | 吃东西 |
| `sleep` | 睡觉 |
| `activateBlock` | 操作门、拉杆等 |
| `openContainer` / `closeContainer` | 开/关容器 |
| `withdraw` / `deposit` | 容器存取物品 |
| `craft` | 合成物品 |
| `farm` | 耕种 |
| `breedAnimals` | 繁殖动物 |
| `fish` | 钓鱼 |
| `trade` | 与村民交易 |
| `finish` | 回复玩家并暂停循环 |
| `command` | *(仅 CHEAT 模式)* 执行任意服务器指令 |

## 工作原理

1. 机器人连接 Minecraft 服务器
2. 每隔 `DECISION_INTERVAL` 毫秒收集状态（位置、血量、背包、附近实体等）
3. 状态 + 动作定义 + 对话历史 一起发送给 LLM
4. LLM 返回 JSON：`{"thinking":"...","actions":[...]}`
5. 机器人依次执行动作
6. 如果 AI 使用 `finish`，循环暂停直到玩家再次说话（CONTINUOUS=true 时除外）
