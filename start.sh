#!/bin/bash

# 注意：这里的三个值要改成自己的
export API_URL="https://api.deepseek.com"
export API_KEY="YOUR_API_KEY"
export API_MODEL="deepseek-v4-flash"


export MC_HOST="${MC_HOST:-localhost}"
export MC_PORT="${MC_PORT:-25565}"
# 注意：MC Java 用户名不能包含下划线，否则会被踢出
export BOT_NAME="${BOT_NAME:-LLMBot}"
export BOT_ROLE="${BOT_ROLE}"
export DECISION_INTERVAL="${DECISION_INTERVAL:-3000}"

cd "$(dirname "$0")"
# 默认允许作弊
CHEAT=true node index.js