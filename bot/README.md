# X-Page 转换 Telegram Bot

一个跑在 Cloudflare Workers 上的 Telegram bot，把 X / Twitter、GitHub、微信公众号链接以及图片 / 视频转成 X-Page 链接。**不需要 VPS**。

## 支持的功能

| 输入 | 输出（X-Page 链接） |
| --- | --- |
| `x.com/<user>/status/<id>` | 完整 / 本推 / 本推+引用 / 串推（4 种 `?mode=`） |
| `github.com/<user>/<repo>/blob/main/<file>` | `/github/<user>/<repo>/<file>` README / 文件渲染 |
| `mp.weixin.qq.com/s...` 公众号文章 | `/wechat/<url>` 文章代理（标题可点回原文） |
| 图片 / 视频消息 | 下载 → 图床（Imgur 优先、ImgBB 兜底）→ `/img/`、`/vid/` 预览 |
| 任意 http(s) URL | `/vid/`、`/img/`、`/html/`（代理 + 直链） |

全部回复均为纯文本模式 —— Telegram 自动把裸 URL 变成可点击链接。

## 结构

```text
bot/
├── worker.js        # Worker 入口：/webhook + 健康检查
├── matcher.js       # 纯函数：链接识别 + X-Page 链接生成（可单测）
├── telegram.js      # Telegram Bot API 客户端
├── media.js         # 媒体：下载 → 图床上传 → X-Page 链接
├── wrangler.toml    # 部署配置（vars、secrets）
├── set-webhook.sh   # 一键设置 webhook
└── README.md
```

## 快速开始

### 1. 创建 bot

在 Telegram 找 [@BotFather](https://t.me/BotFather)，`/newbot` 创建，记下 **token**（形如 `123456789:AA...`）。

### 2. 配置 & 部署

图床密钥可复用项目根 `.env` 里的 `IMGUR_CLIENTID` / `IMGBB_API_KEY`：

```bash
cd bot

# 写入 secrets
npx wrangler secret put BOT_TOKEN          # BotFather token
npx wrangler secret put WEBHOOK_SECRET     # 自己生成，如 openssl rand -hex 16
npx wrangler secret put IMGUR_CLIENTID     # Imgur Client-ID（图片优先 / 视频）
npx wrangler secret put IMGBB_API_KEY      # ImgBB API Key（图片兜底）
npx wrangler secret put X_PAGE_BASE        # X-Page 服务根地址（以 secret 设置，不含默认值）
npx wrangler secret put ALLOWED_CHATS      # 白名单（见下方说明）

# 白名单以 Worker Secret 存储（wrangler secret put ALLOWED_CHATS）：
# 只允许指定群话题 + 指定用户私聊使用（格式：逗号分隔，每项 `<chatId>` 或 `<chatId>:<threadId>`）
# 留空则响应所有来源（不推荐）。修改后重新部署即可生效。

npx wrangler deploy
```

### 3. 设置 webhook

需要一个公开 HTTPS 地址。最快用 workers.dev 子域，正式使用建议绑自定义域名（如 `bot.zydou.me`）：

```bash
./set-webhook.sh <BOT_TOKEN> "https://<bot域名>/webhook" <WEBHOOK_SECRET>
```

`set-webhook.sh` 会带上 `allowed_updates=["message"]`、`drop_pending_updates=true` 和 `secret_token`。bot Worker 用 `WEBHOOK_SECRET` 校验 `X-Telegram-Bot-Api-Secret-Token` 头，不一致的请求返回 403。

### 4. 测试

```bash
# 健康检查
curl https://<bot域名>/

# 给 bot 发一条推特链接或 /start，确认回复
```

## 工作原理

```text
Telegram ──webhook POST──▶ /webhook ──校验 secret──▶ 处理更新（waitUntil，立即返回 200）
                                 │
                                 ├─ 文本链接 ──▶ buildReply() 纯字符串拼接 ──▶ sendMessage
                                 └─ 图片/视频 ──▶ getFile → 下载 → 图床上传 ──▶ sendMessage
                                                    (Imgur→ImgBB)       │
                                                                        ▼
                                                     用户点开 X-Page /img/ /vid/ 链接
                                                     X-Page /proxy/ ──▶ 图床公网直链
```

- **webhook 立即返回 200**：实际处理放进 `ctx.waitUntil`，避免 Telegram 因响应慢而重复投递导致 bot 反复回复。
- **媒体不落 R2**：容量交给图床。图片优先 Imgur，失败回退 ImgBB（base64）；视频只走 Imgur。上传成功拿到公网直链后，回复指向该直链的 X-Page `/img/`、`/vid/` 链接，之后 X-Page 的 `/proxy/` 走 CDN 缓存（1 年）。
- **不设 parse_mode**：纯文本模式下 Telegram 自动把裸 URL 变成可点击链接；同时关闭 link preview，避免一条回复带多个链接时预览噪音。

## 已知限制

- **Telegram Bot API 单次下载上限 20MB**：超过的图片 / 视频会回复提示"文件超过 20MB"，不会尝试下载。Telegram 里很多视频都超这个大小，发链接比发文件更稳妥。
- **图床依赖**：Imgur / ImgBB 是第三方服务，有各自的速率限制与可用性风险；图片在 Imgur 失败时会自动回退 ImgBB，视频失败则提示重试。图床链接理论上可能随时间失效（取决于平台策略）。
- **免费档 CPU 时间 10ms / 请求**：链接转换是纯字符串拼接（零网络），不受影响；媒体下载 + 上传以 I/O 为主，实测一般可行。若媒体处理频繁报"处理失败"，把 Worker 升到付费档（CPU 30s）即可。
- **仅支持 X / GitHub / 微信公众号 / 通用 URL**：与 X-Page 路由一致。抖音 / B站等平台 X-Page 本身不支持，bot 也不转换。

## 调试

```bash
# 本地起 dev（需先设 secrets，或用 --var 覆盖）：
npx wrangler dev --var BOT_TOKEN:xxx --var WEBHOOK_SECRET:yyy

# 伪造一条 webhook 更新：
curl -X POST http://localhost:8787/webhook \
  -H "X-Telegram-Bot-Api-Secret-Token: yyy" \
  -H "Content-Type: application/json" \
  -d '{"update_id":1,"message":{"message_id":1,"date":0,"chat":{"id":1,"type":"private"},"text":"https://x.com/a/status/123"}}'
```
