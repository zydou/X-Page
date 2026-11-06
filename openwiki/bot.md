---
type: 子系统
title: Telegram 机器人
description: 介绍 Telegram 转换机器人的 webhook 安全模型与链接转换工作流
tags: [Telegram, Bot, webhook, 链接转换]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T01:57:17.825Z
sources:
  - id: openwiki-source-3dec53bd176af78782129d6d
    resource: repo://lib/bot/matcher.js
  - id: openwiki-source-ff7c76c2916da09362dc8be5
    resource: repo://lib/bot/media.js
  - id: openwiki-source-05a173a47d37ba0d0ecc2550
    resource: repo://lib/bot/telegram.js
  - id: openwiki-source-7ac255018a231eb231733c3f
    resource: repo://routes/webhook.js
generated: { by: "claude-code", at: "2026-11-06T01:57:17.825Z" }
---

# Telegram 机器人

`POST /webhook` 是 x-page 提供的 Telegram 转换机器人入口：用户把链接或媒体发给 bot，bot 回复所有可用的 X-Page 转换结果。整个功能与 Worker 同进程部署、共用同一 hostname，没单独的 Worker。

相关：路由排队顺序见 [路由与请求处理](routing.md)，媒体与 URL 代理本身见 [媒体代理与 GitHub 渲染](media-github.md)。

## 1 安全模型：webhook secret_token

`routes/webhook.js:44-48` 在入口即校验 Telegram 设置 `secret_token` 时塞入的请求头 `X-Telegram-Bot-Api-Secret-Token`：

- 请求 method 不是 `POST` 直接 405 `{ method not allowed }`（`routes/webhook.js:41-43`）。
- `env.WEBHOOK_SECRET` 未配置或请求头值不等于它，返回 403 `{ forbidden }`——**fail-closed**，不走降级。注释里明确说明用 `wrangler secret put WEBHOOK_SECRET` 配置，secret 由 `setWebhook` 时指定，所有非 Telegram 的请求都被挡掉（`routes/webhook.js:6-8`）。

## 2 响应与处理解耦：ctx.waitUntil

合法请求后 `handleWebhook` 不在返回前完成后续逻辑——`ctx.waitUntil(handleUpdate(update, env))` 把处理交给后台 promise，前台 200 立刻返回（`routes/webhook.js:50-51`）。原因是 Telegram 响应慢会触发重复投递，重复投递会让 bot 反复回复用户同一条消息。

## 3 白名单 ALLOWED_CHATS

`webhook.js:65-66` 调用 `isAllowed(msg, env.ALLOWED_CHATS)` 先判来源。配置格式是逗号分隔的 `<chatId>` 或 `<chatId>:<threadId>`：

- `<chatId>` 匹配该 chat 里任何 thread（私聊时 chat.id = user id，无 thread）。
- `<chatId>:<threadId>` 同时匹配指定 forum 话题。
- **未配置 / 空字符串时响应所有来源**（`routes/webhook.js:122-123`），相当于无白名单模式。

白名单只过滤**来源**，不包括发送者过滤——任何能发消息到该 chat 的人都在范围内。名单本身存在 Worker Secret，不落代码。

## 4 链接识别与回复生成

文本消息（`msg.text` 或 `caption`）进 `lib/bot/matcher.js` 的 `buildReply(text, xPageBase)`。`X_PAGE_BASE` 必须由调用方从 Secret 传入——缺失即直接报错回复用户，不会用硬编码兜底（`routes/webhook.js:71-76`）。

### 4.1 平台识别（matchSocialMediaLink）

| 平台 | 匹配规则 | 返回字段 |
|---|---|---|
| X / Twitter | `(twitter\|x\|fxtwitter\|fixupx\|vxtwitter).com/<handle>/status/<id>`，含 fxtwitter 镜像域名 | `handle`, `post_id` |
| GitHub | `github.com/<user>/<repo>[/<subpath>]`，user 匹配 `[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*`（拒绝尾随连字符） | `gh_user`, `gh_repo`, `query` |
| 微信公众号 | `mp.weixin.qq.com/s...`，查询串字符集含 `+ %`（因为 `__biz` 等参数是 base64） | `url` |

`firstHttpUrl()` 是通用 URL 兜底，字符类与 `lib/utils.js` 的 `makeUrlClickable` 同款，末尾把句号、逗号、右括号等标点排除出去（`lib/bot/matcher.js:21`）。

### 4.2 回复生成（buildReply）

优先级 X → GitHub → 微信 → 通用 URL，无匹配时返回空字符串、调用方静默不回复（`lib/bot/matcher.js:83-87`）。

- **X**：一次回出 4 条 URL——完整 / `?mode=self` / `?mode=quote` / `?mode=thread`（`lib/bot/matcher.js:95-102`）。
- **GitHub**：`releases/` 开头的列表页直接不转换（`lib/bot/matcher.js:107`）；`blob/main/README.md` 会把 `blob/<branch>/` 前缀剥掉再补上文件名（`lib/bot/matcher.js:110-111`），最终拼成 `{base}/github/{user}/{repo}{path}`，与 [媒体代理与 GitHub 渲染](media-github.md) 的 `/github/` 路由入口对齐。
- **微信**：整页 URL `encodeURIComponent` 后挂到 `{base}/wechat/{enc}`，与 `/wechat/` 路由的改写规则联动。
- **通用 URL**：按扩展名 `checkTextType()` 判定 image / video / other：
  - image：回 `/img/` 代理 + `/img/d/` 直链两条（`lib/bot/matcher.js:126-127`）。
  - video：回 `/vid/` + `/vid/d/` 两条（`lib/bot/matcher.js:129-130`）。
  - other：回 `/vid/`、`/vid/d/`、`/img/`、`/img/d/`、`/html/` 五条全套（`lib/bot/matcher.js:132-138`），让用户自己挑。

## 5 媒体消息：下载与图床上传

`mediaTypeOf()` 判定消息的媒体类型（`lib/bot/media.js:26-35`）：`msg.photo` → image，`msg.video` → video，`msg.document` 按 mime 前缀判断。非媒体则走文本路径。

媒体处理路径 `handleMedia()`（`lib/bot/media.js:128-165`）：

1. `getFile()` 拿 file_path（Telegram Bot API 限制单文件 20MB，`MAX_FILE_SIZE = 20 * 1024 * 1024`）。
2. `file_size` 超限时提前回复「超过 20MB，请改用链接」，不浪费一次必败的下载（`lib/bot/media.js:139-142`）。
3. 用 `fileUrl()` 构造下载 URL 下载完整字节；媒体**不落 R2**，容量交给图床，Worker 保持无状态。
4. 上传策略：图片先 Imgur、失败回退 ImgBB；视频只走 Imgur（ImgBB 仅收图片）——`uploadImgur()` 用 `Client-ID` 头，`uploadImgbb()` 用 base64 `URLSearchParams`。成功后回复 `{base}/img/{enc}` 或 `{base}/vid/{enc}` 指向图床公网 URL。

> [!NOTE]
> `fileUrl()` 构造的 URL 内嵌 `BOT_TOKEN`（`lib/bot/telegram.js:95-97`），只能在 Worker 服务端使用，千万不要下发到客户端。

## 6 发送逻辑与 `link_preview_options`

`sendMessage()` 刻意**不设** `parse_mode`——纯文本模式下 Telegram 自动把裸 URL 变成可点击链接，正是多行链接回复想要的呈现；同时 `link_preview_options.is_disabled = true` 关闭预览，避免一条回复带 2~6 个链接时每个都渲染 OG 预览（`lib/bot/telegram.js:41-44,50-56`）。

发送前会先 `sendChatAction()` 打 `typing` / `upload_photo` / `upload_video` 动作，让长任务有即时反馈（`routes/webhook.js:80,88-89,95`）。

## 7 预热：回复后内部直调预热写 R2

`sendMessage()` 之后，文本通道会按 `buildPrewarmTargets(text)` 算出的目标数组逐个内部直调预热（`prewarmCache`，`routes/webhook.js` ），触发真实路由回源并写 R2，让用户点开链接时直接命中缓存。

- 只覆盖会写 R2 的两条路由：X/Twitter → `prewarmTweet(pid, env, ctx)`（内部调 `fetchTweetData`，R2 key 只跟 lang 维度有关，与 mode 无关，一次足够）；微信公众号 → `prewarmWechat(url, env, ctx)`（复用 `serveHtml` 抓取与改写，最终 HTML 写 R2）。
- GitHub、通用媒体 URL 等不落 R2 的平台不做预热，`buildPrewarmTargets` 返回空数组。
- 为什么内部直调而非 GET 自家域名：`wrangler tail` 实测自 fetch 自定义域名撞 Cloudflare 边缘缓存层 522（`prewarm 失败: HTTP 522`），直接调用 handler 完全走 Worker 内部链路、不经边缘。
- 失败只记 `console.error("prewarm 失败:", ...)`，不重试也不通知用户；回复已在预热前发完，预热失败完全无感。

## 8 错误处理与白名单之外的容错

`handleUpdate()` 的整个处理体包在 try/catch 里（`routes/webhook.js:64-107`）：异常时打 `console.error` 记录、并尽力 `sendMessage` 一条 `⚠️ 处理失败：<msg>` 给用户，通知失败也不再向上传播——因为这是 `ctx.waitUntil` 后台任务，静默失败用户只会看到 bot 没动静。

命令 `/start` / `/help` 走 `HELP` 静态文本，一次性回出支持的转换列表（`routes/webhook.js:23-30,79-83`），不打任何网络。

## 9 Secrets 清单

| Secret | 用途 |
|---|---|
| `BOT_TOKEN` | Telegram Bot API 根路径，`apiBase()` 与 `fileUrl()` 构造 URL 时内嵌 |
| `WEBHOOK_SECRET` | webhook 入口 fail-closed 校验头 |
| `IMGUR_CLIENTID` | 图床上传 Imgur 认证 |
| `IMGBB_API_KEY` | 图片回退上传 ImgBB 认证 |
| `X_PAGE_BASE` | 生成的 X-Page 链接根地址，无兜底——缺失即拒绝转换 |
| `ALLOWED_CHATS` | 白名单 chat / thread 组合，见第 3 节 |

这些 secret 由 `wrangler secret put` 设置，每次部署的 Worker 运行时读取，**不能**烧进 bundle。

## 10 关联

- 所有请求如何排队进 `/webhook` → [路由与请求处理](routing.md)
- GitHub 链接转换后渲染什么样的 HTML → [媒体代理与 GitHub 渲染](media-github.md)
- 微信与 HTML 代理本身的改写规则 → [HTML 与微信文章代理](html-wechat.md)
