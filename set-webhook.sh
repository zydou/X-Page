#!/bin/bash
# ============================================================
# 设置 Telegram webhook（X-Page 转换 Bot）。
#
# 用法：
#   ./set-webhook.sh <BOT_TOKEN> <WEBHOOK_URL> <SECRET_TOKEN>
#
# 示例：
#   ./set-webhook.sh 123456:ABC-DEF https://<your-worker-domain>/webhook mys3cret
#
# 其中：
#   - WEBHOOK_URL  是 X-Page Worker 的 /webhook 公开地址（与站点共用域名）
#   - SECRET_TOKEN 会写入 X-Telegram-Bot-Api-Secret-Token 头，
#                  Worker 端以 WEBHOOK_SECRET 校验（两处必须一致）
# ============================================================
set -e

TOKEN="$1"
URL="$2"
SECRET="$3"

if [ -z "$TOKEN" ] || [ -z "$URL" ] || [ -z "$SECRET" ]; then
  echo "用法: $0 <BOT_TOKEN> <WEBHOOK_URL> <SECRET_TOKEN>"
  exit 1
fi

# JSON 构造交给 python3，避免 URL 里 & / ? 等字符破坏 json
PAYLOAD=$(python3 -c 'import json,sys;print(json.dumps({"url":sys.argv[1],"secret_token":sys.argv[2],"allowed_updates":["message"],"drop_pending_updates":True}))' "$URL" "$SECRET")

echo "==> setWebhook → $URL"
curl -sS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD"
echo

echo "==> getWebhookInfo"
curl -sS "https://api.telegram.org/bot${TOKEN}/getWebhookInfo"
echo
