---
type: 系统
title: 路由与请求处理
description: 说明统一 Worker 如何分发请求到各子路由，强调路由优先级与兜底逻辑
tags: [路由, 请求分发, Worker]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-05T11:10:10.273Z
sources:
  - id: openwiki-source-1adf5eb6c74462684e873d78
    resource: repo://worker.js
generated: { by: "claude-code", at: "2026-11-05T11:10:10.273Z" }
---

# 路由与请求处理

`worker.js` 是 x-page 唯一 Cloudflare Worker 入口。整服务用 `export default { fetch }` 暴露，所有路由走一个 `worker.js` 文件的分发链、各自在 `routes/` 下独立成文件。

## 1 路由分发优先级

`worker.js:61-119` 的 `fetch()` 收到请求后先对 `pathname` 去首斜杠、做一次 `decodeURIComponent`（失败时保留原值、靠下游再 decode 一次），然后按顺序判断、把命中的路径委托给子模块的 handler：

| 优先级 | 匹配条件 | 处理者 | 用途 |
|---|---|---|---|
| 1 | `/` 空路径 | `routes/index.js` 的 `indexHtml()` | 使用说明页（中英双语） |
| 2 | `favicon.ico` | 静默返回 204 | 不进其他 |
| 3 | 名为 `webhook` | `routes/webhook.js` 的 `handleWebhook()` | Telegram bot webhook |
| 4 | `vid/` 或 `vid` | `routes/video.js` `serveVideo()` | 视频播放器 HTML |
| 5 | `img/` 或 `img` | `routes/image.js` `serveImage()` | 图片预览 HTML |
| 6 | `html/` 或 `html` | `routes/html.js` `serveHtml()` | HTML 抓取改写 |
| 7 | `wechat/` 或 `wechat` | `routes/wechat.js` `serveWechat()` | 微信公众号文章 |
| 8 | `proxy/` 或 `proxy` | `routes/proxy.js` `handleProxy()` | 通用媒体代理 |
| 9 | `github/` 或 `github` | `routes/github.js` `serveGithub()` | GitHub README/文件渲染 |
| 10 | 其余全部 | `routes/tweet.js` `serveTweet()` | 推文（兜底） |

### 1.1 为什么顺序是这个样子

- **根路径先来**：`/index` 用量页由 `routes/index.js` 的静态模板直接生成，不做异步 I/O，返回的是纯字符串 HTML。
- **favicon 静默吞掉**：避免 404 噪音。
- **webhook 在媒体子路由之前**：它是唯一非 GET 的模式（POST 入口）。
- **推文是兜底**：`/<user>/status/<id>` 形态最宽泛，任何不符合其他前缀的路径都试着按推文格式解析。新加固定前缀的子路由都必须插到推文判断之前。

### 1.2 兜底逻辑与 404

最终 fallback 是推文 handler；`extractPid()` 提取不出 tweet ID 时返回 404 `Not found`；无法解析的路径最终走 404，不会挂起也不会 crash。

## 2 各子路由做什么

### 2.1 `GET /` → 说明页

`routes/index.js` 的 `indexHtml(host)` 用调用方的 host 头生成中英双语使用说明页，列出各前缀用法示例，不依赖服务端异步时间渲染。

### 2.2 `POST /webhook` → Telegram Bot

`handleWebhook(request, env, ctx)` 校验其余请求一律 403（fail-closed）。见 [Telegram 机器人](bot.md)。

### 2.3 `GET /vid/...` → 视频播放器

`serveVideo(request, cleanPath, host, ARTPLAYER_JS)`。内联 Artplayer JS 拼出完整页面，见 [媒体代理与 GitHub 渲染](media-github.md)。

### 2.4 `GET /img/...` → 图片预览

`serveImage(request, cleanPath, host)`。轻量自适应 HTML，图片居中。

### 2.5 `GET /html/...` → HTML 改写代理

`serveHtml(request, env, ctx, transform?, prefix?)`。抓上游、用 `HTMLRewriter` 改写资源、把 `<a>` 导航仍留在代理体系。见 [HTML 与微信文章代理](html-wechat.md)。

### 2.6 `GET /wechat/...` → 微信公众号文章

`serveWechat(request, env, ctx)`。复用 `serveHtml` 的逻辑，额外做标题包链接与 R2 永久缓存。

### 2.7 `GET /proxy/...` → 通用媒体代理

`handleProxy(request)`。透传 Range、响应头写死长缓存与 inline。见 [媒体代理与 GitHub 渲染](media-github.md)。

### 2.8 `GET /github/...` → GitHub 仓库浏览

`serveGithub(request, env, cleanPath, rawPathname, WATER_CSS, HLJS)`。文档走 GitHub API 渲染 markdown，代码文件走 highlight.js Worker 端高亮。见 [媒体代理与 GitHub 渲染](media-github.md)、[Markdown 转换](markdown.md)。

### 2.9 `GET /<user>/status/<id>` → 推文

`serveTweet(request, env, cleanPath, WATER_CSS, TWITTER_CSS, ctx)`。按 fxtwitter 数据渲染自包含 HTML；`Accept: text/markdown` 时走 Markdown 分支。见 [推文服务](tweet.md)、[Markdown 转换](markdown.md)。

## 3 路径预处理

`worker.js` 入站后先做一次 `decodeURIComponent`，这样中文路径也能识别；失败时保留原值、由子模块再 decode 一次。子路由拿到的 `cleanPath` 已去首斜杠；有的路由（如 `/github/`）还会拿原始 pathname 来检测 `@ref` 里的 `%2F`。

## 4 资产注入路径

`worker.js:28-31` 导入三份内联资产（`WATER_CSS`、`TWITTER_CSS`、`ARTPLAYER_JS`），`worker.js:37` 导入 `highlight.mjs`，都会作为参数下发给需要它们的下游（`video`、`tweet`、`github`），子模块不自行 import。原因：Wrangler Text module rule 要求 import 必须写在入口文件，子模块用 ESM 导入这些文本模块不可行。见 [内联资产与构建部署](assets-and-build.md)。

## 5 关联

- 所有请求最终分成九条子服务 —— [快速上手](quickstart.md) 服务目录
- Telegram Bot 如何接住 /webhook → [Telegram 机器人](bot.md)
- /github/ 的 Markdown 渲染管线 → [Markdown 转换](markdown.md)
