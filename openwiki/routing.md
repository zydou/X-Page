---
type: 系统
title: 路由与请求处理
description: 说明统一 Worker 如何分发请求到各子路由，强调路由优先级、外置 /assets/ 分支与兜底逻辑
tags: [路由, 请求分发, Worker]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-12T06:31:33.521Z
sources:
  - id: openwiki-source-8671e0889cf4d1fe8869457d
    resource: repo://routes/index.js
  - id: openwiki-source-1adf5eb6c74462684e873d78
    resource: repo://worker.js
generated: { by: "claude-code", at: "2026-11-12T06:31:33.521Z" }
---

# 路由与请求处理

`worker.js` 是 x-page 唯一 Cloudflare Worker 入口。整服务用 `export default { fetch }` 暴露，所有路由走一个 `worker.js` 文件的分发链、各自在 `routes/` 下独立成文件。

## 1 路由分发优先级

`worker.js:71-150` 的 `fetch()` 收到请求后先对 `pathname` 去首斜杠、做一次 `decodeURIComponent`（失败时保留原值、靠下游再 decode 一次），然后按顺序判断、把命中的路径委托给子模块的 handler：

| 优先级 | 匹配条件                | 处理者                                   | 用途 |
| ------ | ----------------------- | ---------------------------------------- | ---- |
| 1      | `/` 空路径              | `routes/index.js` 的 `indexHtml()`       | 302 跳转到 `https://github.com/zydou/X-Page` |
| 2      | `favicon.ico`           | 静默返回 204                             | 不进其他 |
| 3      | 名为 `webhook`          | `routes/webhook.js` 的 `handleWebhook()` | Telegram bot webhook |
| 4      | `vid/` 或 `vid`         | `routes/video.js` `serveVideo()`         | 视频播放器 HTML |
| 5      | `img/` 或 `img`         | `routes/image.js` `serveImage()`         | 图片预览 HTML |
| 6      | `html/` 或 `html`       | `routes/html.js` `serveHtml()`           | HTML 抓取改写 |
| 7      | `r2-html/` 或 `r2-html` | `routes/html.js` `serveR2Html()`         | HTML 抓取改写 + R2 持久缓存 |
| 8      | `wechat/` 或 `wechat`   | `routes/wechat.js` `serveWechat()`       | 微信公众号文章 |
| 9      | `proxy/` 或 `proxy`     | `routes/proxy.js` `handleProxy()`        | 通用媒体代理 |
| 10     | `assets/` 前缀          | `worker.js` 内联分支                     | 外置静态 CSS/JS（immutable 长缓存） |
| 11     | `github/` 或 `github`   | `routes/github.js` `serveGithub()`       | GitHub README/文件渲染 |
| 12     | 其余全部                | `routes/tweet.js` `serveTweet()`         | 推文（兜底） |

完整优先级链：root → favicon → webhook → `/vid/` → `/img/` → `/html/` → `/r2-html/` → `/wechat/` → `/proxy/` → `/assets/` → `/github/` → tweet（兜底）→ 404。

### 1.1 为什么顺序是这个样子

- **根路径先来**：`/` 由 `routes/index.js` 的 `indexHtml()` 返回 302 重定向到项目 GitHub 主页，不做异步 I/O。
- **favicon 静默吞掉**：避免 404 噪音。
- **webhook 在媒体子路由之前**：它是唯一非 GET 的模式（POST 入口）。
- **`/assets/` 在 proxy 之后、github 之前**：静态资产分支（`worker.js:127-141`）匹配 `assets/` 前缀，按文件名从 Text module 导入的字符串里取 body 外置 serve，带
  `Cache-Control: public, max-age=31556952, immutable`。它必须排在推文兜底之前，否则 `assets/twitter.css` 会被当推文解析。
- **`/r2-html/` 紧跟 `/html/`**：两者共用 `routes/html.js` 的抓取改写能力，`/r2-html/` 只是 HTML 视图多缓存一层 R2，语义上是一对，所以相邻排列（`worker.js:112-114`）。
- **推文是兜底**：`/<user>/status/<id>` 形态最宽泛，任何不符合其他前缀的路径都试着按推文格式解析。新加固定前缀的子路由都必须插到推文判断之前。

### 1.2 兜底逻辑与 404

最终 fallback 是推文 handler；`extractPid()` 提取不出 tweet ID 时返回 404 `Not found`；无法解析的路径最终走 404，不会挂起也不会 crash。

## 2 各子路由做什么

### 2.1 `GET /` → 302 跳 GitHub

`routes/index.js` 的 `indexHtml(_host)` 返回 302，`location` 指向 `https://github.com/zydou/X-Page`（`routes/index.js:8,16-21`）。`_host` 参数保留以兼容 `worker.js` 调用方但不再使用。

### 2.2 `POST /webhook` → Telegram Bot

`handleWebhook(request, env, ctx)` 校验其余请求一律 403（fail-closed）。见 [Telegram 机器人](bot.md)。

### 2.3 `GET /vid/...` → 视频播放器

`serveVideo(request, cleanPath, host)`。外链 `/assets/artplayer.js` 加载播放器库拼出完整页面，见 [媒体代理与 GitHub 渲染](media-github.md)。

### 2.4 `GET /img/...` → 图片预览

`serveImage(request, cleanPath, host)`。轻量自适应 HTML，图片居中。

### 2.5 `GET /html/...` → HTML 改写代理

`serveHtml(request, env, ctx, transform?, prefix?)`。抓上游、用 `HTMLRewriter` 改写资源、把 `<a>` 导航仍留在代理体系。见 [HTML 与微信文章代理](html-wechat.md)。

### 2.6 `GET /r2-html/...` → HTML 改写代理 + R2 持久缓存

`serveR2Html(request, env, ctx)`。
与 `/html/` 功能完全一致，唯一差异是 HTML 视图多一层 R2 持久缓存（key `html/<原文URL>`）：命中直接返回缓存，miss 才走 `serveHtml` 抓取并后台写回。
它排在 `/html/` 之后、`/wechat/` 之前（`worker.js:112-114`）。
见 [HTML 与微信文章代理](html-wechat.md)、[存储与 AI 绑定](storage-and-ai.md)。

### 2.7 `GET /wechat/...` → 微信公众号文章

`serveWechat(request, env, ctx)`。复用 `serveHtml` 的逻辑，额外做标题包链接与 R2 永久缓存。

### 2.8 `GET /proxy/...` → 通用媒体代理

`handleProxy(request)`。透传 Range、响应头写死长缓存与 inline。见 [媒体代理与 GitHub 渲染](media-github.md)。

### 2.9 `assets/<name>` → 外置静态资产

`worker.js:127-141` 的内联分支。按 `assetName` 从 `{ "twitter.css", "github.css", "artplayer.js" }` 里取 Text module 导入的 body，带 immutable 长缓存返回；未命中返回 404。见
[外置资产与构建部署](assets-and-build.md)。

### 2.10 `GET /github/...` → GitHub 仓库浏览

`serveGithub(request, env, cleanPath, rawPathname, hljs)`。文档走 GitHub API raw + markdown-it 渲染，代码文件走 highlight.js Worker 端高亮；`rawPathname`（未 decode）用于检测 `@ref` 里的 `%2F`。见
[媒体代理与 GitHub 渲染](media-github.md)、[Markdown 转换](markdown.md)。

### 2.11 `GET /<user>/status/<id>` → 推文

`serveTweet(request, env, cleanPath, ctx)`。按 fxtwitter 数据渲染自包含 HTML；`Accept: text/markdown` 时走 Markdown 分支。见 [推文服务](tweet.md)、[Markdown 转换](markdown.md)。

## 3 路径预处理

`worker.js` 入站后先做一次 `decodeURIComponent`，这样中文路径也能识别；失败时保留原值、由子模块再 decode 一次。子路由拿到的 `cleanPath` 已去首斜杠；有的路由（如 `/github/`）还会拿原始 pathname 来检测
`@ref` 里的 `%2F`。

## 4 资产注入路径

`worker.js:37-39` 通过 Text module 导入三份**浏览器资产**（`artplayer.mjs`、`assets/twitter.css`、`assets/github.css`），但不再作为参数下发给下游、也不内联进页面，而是在 `/assets/` 分支外置
serve（`worker.js:127-141`）；`video.js`、`tweet.js`、`github.js` 改用 `<script src>` / `<link href>` 外链引用。`worker.js:45` 另以 `import * as HLJS` 导入 `highlight.mjs`，它作为参数传给
`serveGithub` 在 Worker 端 SSR 渲染、不下发浏览器。Wrangler Text module rule 要求 import 必须写在入口文件，子模块用 ESM 导入这些文本模块不可行。见 [外置资产与构建部署](assets-and-build.md)。

## 5 关联

- 所有请求最终分成若干子服务 → [快速上手](quickstart.md) 服务目录
- Telegram Bot 如何接住 /webhook → [Telegram 机器人](bot.md)
- /github/ 的 Markdown 渲染管线 → [Markdown 转换](markdown.md)
- /assets/ 外置资产的来源与构建 → [外置资产与构建部署](assets-and-build.md)
