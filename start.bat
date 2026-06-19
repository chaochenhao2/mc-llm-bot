@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

::这里个三个数值需要修改为自己的！！！
set API_URL=https://api.deepseek.com
set API_KEY=YOUR_API_KEY
set API_MODEL=deepseek-v4-flash



if not defined MC_HOST set MC_HOST=localhost
if not defined MC_PORT set MC_PORT=25565
rem MC Java 用户名不能包含下划线，否则会被踢出
if not defined BOT_NAME set BOT_NAME=LLMBot
if not defined BOT_ROLE set BOT_ROLE=
if not defined DECISION_INTERVAL set DECISION_INTERVAL=3000

cd /d "%~dp0"
:: 默认允许作弊
set CHEAT=true
node index.js

if errorlevel 1 (
    echo.
    echo 机器人已退出，按任意键关闭...
    pause >nul
)
