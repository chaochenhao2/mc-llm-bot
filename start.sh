#!/bin/bash
export API_URL="${API_URL:-https://api.openai.com/v1}"
export API_KEY="${API_KEY:?API_KEY is required}"
export API_MODEL="${API_MODEL:-gpt-4o}"
export MC_HOST="${MC_HOST:-localhost}"
export MC_PORT="${MC_PORT:-25565}"
export BOT_NAME="${BOT_NAME:-LLM_Bot}"
export BOT_ROLE="${BOT_ROLE}"
export DECISION_INTERVAL="${DECISION_INTERVAL:-3000}"

cd "$(dirname "$0")"
# 默认允许作弊
CHEAT=true node index.js