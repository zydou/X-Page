---
type: 子系统
title: Markdown 转换
description: 解释四条路由的 Markdown 变体生成、约束与缓存机制
tags: [Markdown, 内容协商, Workers AI, R2缓存]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-12T05:54:32.565Z
sources:
  - id: openwiki-source-8a2e26d4137b8250f68bb869
    resource: repo://build.sh
  - id: openwiki-source-4cc5b54b5fc77565a9fc3760
    resource: repo://lib/markdown.js
  - id: openwiki-source-529e9dc3a2b5d10c27b03b93
    resource: repo://lib/to-markdown.js
  - id: openwiki-source-191ac1117a045536f59c18b2
    resource: repo://routes/html.js
  - id: openwiki-source-3e61b3820564ba3d588667cf
    resource: repo://routes/wechat.js
generated: { by: "claude-code", at: "2026-11-12T05:54:32.565Z" }
---

# Markdown 转换

x-page 支持在四条路由上按 `Accept: text/markdown` 内容协商返回 Markdown 文本：`/<user>/status/<id>`、`/html/<url>`、`/r2-html/<url>`、`/wechat/<url>`。Markdown 是为 Agent / CLI 消费的轻量表示，与 HTML 双轨并行。

## 1 内容协商总则

> [!IMPORTANT]
> 四个 Markdown 分支都设 `Vary: Accept`——同一 URL 存在 HTML / Markdown 两种表示，不带这个头边缘缓存会把 HTML 喂给要 Markdown 的客户端（`routes/tweet.js:672`、`routes/html.js:409`、`lib/to-markdown.js:147`）。`GET /<...>/status/<id>` 与 `/html/` `/r2-html/` `/wechat/` 的 HTML 默认也带 `Vary: Accept` 保持一致。

- **Markdown 变体场景**：请求头 `Accept` 包含 `text/markdown`（例如 `curl -H "Accept: text/markdown"`），其余请求返回 HTML 不变。
- **响应头**：`content-type: text/markdown; charset=utf-8`、`cache-control: no-store`、`vary: Accept`、`x-markdown-tokens`（CJK 感知的 `estimateTokens()` 估算）和 `x-cache: hit|miss`（html/wechat 的
  `markdownResponse()` 组装，`lib/to-markdown.js:142-153`；tweet 路由同样头，`routes/tweet.js:669-674`）。

## 2 四条路由的 Markdown 来源

### 2.1 推文：直接从 fxtwitter 数据渲染

`serveTweet()` 先把 `Accept` 协商出 `wantsMarkdown`，再共用一次 `fetchTweetData()` 拿 fxtwitter thread JSON（`routes/tweet.js:657`）。Markdown 分支走 `renderMarkdown(data, cfg, mode, refreshUrl, pid)`
把结构化数据直接渲染成 Markdown，不经 HTML 中转。推文 Markdown 本身没有独立的 R2 缓存——底层 thread JSON 已按 `tweet/<id>.<lang>.json` 缓存，Markdown 每次即时渲染。缓存键带语言维度：`?lang=ja` 与
`?lang=zh-cn` 各存一份（`routes/tweet.js:708-711`）。

### 2.2 /html/、/r2-html/ 与 /wechat/：Workers AI toMarkdown 转换

`serveHtml()` 的 `serveMarkdown()`（`routes/html.js:282-353`）：

1. **R2 查缓存** `md/<mdNs>/<target>`（`routes/html.js:287`）。`mdNs` 由调用方通过 `serveHtml` 的显式参数传入（默认 `"html"`，`/wechat/` 传 `"wechat"`），不从路由前缀推导。`?refresh=` 强制跳缓存、覆盖写回。
2. **抓上游**（沿用 `fetchUpstream()` 的 iOS 微信 UA + 自家 Referer）。
3. **HTMLRewriter 改写资源**，命中站点 hack 时在缓冲好的完整 HTML 上应用 `applySiteHack`，再转给 Workers AI `toMarkdown`。
4. **写回 R2** 经 `ctx.waitUntil` 后台执行。

`/r2-html/` 的 Markdown 变体走的就是这条 `serveMarkdown` 管线——`serveR2Html` 检测到 `Accept: text/markdown` 会**先短路**给 `serveHtml(前缀 "/r2-html/")`，它与 `/html/` 共用 `md/html/<target>` 缓存。
两条路由的 Markdown 产物相同（都无 `transform`、同一抓取与改写参数、同一 origin 注入 `<base>`），所以同一个 URL 不管经哪条路由第一次转换，另一条都直接命中（`routes/html.js:491-494`）。
这与 `/r2-html/` 的 HTML 视图缓存（`html/<target>`）是两套互不干扰的 key：Markdown 请求读的是自己的 `md/` 命名空间，**不依赖 HTML 视图是否缓存 R2**，所以即便 HTML 视图走的是不缓存的 `/html/`，Markdown 变体照样能命中 `md/html/<target>` 缓存。

`/wechat/` 的 Markdown 变体同理，与 HTML 缓存 key 完全独立，HTML 缓存是 `wechat/<原文URL>`、Markdown 是 `md/wechat/<原文URL>`，且 Markdown 协商在 R2
命中判断**之前**短路（`routes/wechat.js:196-198`），否则缓存 HTML 会被无视 Accept 回给 Markdown 客户端。

## 3 Workers AI toMarkdown 的零成本真相

`lib/to-markdown.js` 头注记录了 2026-10 从 Browser Run 迁移过来的结论：

|          | Browser Run（旧）                                                 | Workers AI toMarkdown（当前） |
| -------- | ----------------------------------------------------------------- | ----------------------------- |
| 免费配额 | 浏览器时间 10 分钟/天（硬墙）， /markdown quick action 1 次/10 秒 | HTML 转 Markdown 是**纯确定性解析**（剥离 script/style、抽 meta、解析相对链接），0 Neuron |
| 限流     | 必须 25 秒 429 退避重试                                           | 无速率限制，单次调用失败直接抛、由调用方返回 502 |
| 实测     | —                                                                 | 3.54 MiB 微信文档 3.3 秒转出 13,301 字符，逐字节确定性 |

> [!NOTE]
> 嵌在 HTML 里的 `<img>` 只变成链接，不触发视觉模型；只有「单独上传图片文件」才烧 Neuron。X-Page 的管线只传 HTML 字符串，所以始终在零 Neuron 路径。

### 3.1 `<base>` 注入而非 `conversionOptions.html.hostname`

相对 URL 绝对化不靠 `conversionOptions.html.hostname`——那条经 REST API 有效，但经 Worker 绑定**被静默忽略**（x-dev 实测：78 个 `/html/` 链接全部原样相对输出）。改用标准 HTML 语义：`injectBase()` 在
`<head>` 开标签后注入 `<base href="<Worker origin>/">`，注入后经 REST 验证与 hostname 输出逐字节一致、二者**不可叠加**（`lib/to-markdown.js:48-79`）。

更进一步：`conversionOptions` 整个对象都到不了服务端（按文档签名 `toMarkdown(files, conversionOptions)` 试过 `html.cssSelector`、完全不生效）。任何裁剪 / 范围诉求都得调用前由 Worker 自己改
HTML，实现在 `/wechat/` 页脚截断上——这也是 `serveHtml` 的 `transform` 钩子要挂 `isMarkdown` 参数的原因。

## 4 缓存、更新与两个头注陷阱

### 4.1 R2 永久缓存

转换结果落 R2 `md/<mdNs>/<target>`，**没有过期规则，永久保留**。转换本身 130–330ms、约 8% 请求有 48–100 秒长尾，不缓存重复请求的代价太高——每个 URL 一生只转一次让重复延迟从秒级压到毫秒级。`?refresh=`
是 R2 永不过期的唯一逃生口，语义是跳读、强制重转、覆盖写回。

`no-store` 的理由很明确（`lib/to-markdown.js:120-153`）：R2 是唯一真相源，边缘那份 `cache-control: max-age` 副本在本账号上 purge 不掉——zone 级 purge（files / hosts / purge_everything）实测全部 success
但完全不生效，只能等 TTL 自己过期。于是缓存收益是「省一次 Worker 调用」，代价是「写坏一次错一年」；R2 免费读额度 10M/月，交换不划算。X-Page 的真实稀缺是 Worker
调用次数（100k/天），本服务量级离它远。边缘缓存以后再加，得先解决 purge 不可用的问题。

### 4.2 输入上限 4 MiB

`MAX_INPUT_CHARS = 3_900_000`，按字符数判定而非字节数（HTML 标签/属性主导，CJK 占比通常 <1%，字符数≈字节数）。超过阈值快速返回 502，不让服务端在长尾里挂 41 秒才回 6006
错误（`lib/to-markdown.js:37-46`）。

### 4.3 输出已知缺陷

实测该转换器会把 URL 中下划线过度编码成 `%5F`（`/path/with_underscore` → `/path/with%5Funderscore`），解码即 `_`、功能无损，但对 Agent 客户是可见 URL 噪声。接受不修（`lib/to-markdown.js:29-31`）。

### 4.4 `x-markdown-tokens` 附带估算

Markdown 响应带 `x-markdown-tokens` 头，是 `lib/utils.js estimateTokens()` 的 CJK 感知估算。没有精确计数可能导致上游 agent 误判 context 窗口，但本实现接受估算而非精确分词。

## 5 /github/ 的 Markdown 渲染管线

`/github/<user>/<repo>[/<path>]` 返回的是**渲染成 HTML** 的文档页，不是 Markdown 文本。其 Markdown 解析发生在 Worker 端：

- `lib/markdown.js` 的 `createMarkdownRenderer(hljs)` 创建 markdown-it 实例（`markdown-it.mjs` 由 CI 用 esbuild 把 npm `markdown-it@14.1.0` 打包成自包含 ESM），开 `html: true`（允许原始
  HTML）、`linkify: true`、关 `typographer`（避免智能引号与代码冲突）。
- `highlight` 回调把代码块交给 highlight.js 着色：语言被识别时返回已着色的 `<span class="hljs-xxx">`；未识别或无语言时返回空串，让 markdown-it 走默认转义、保留 `language-xxx` class 作为 CSS 钩子。
- `/github/` 的文档路径还走 `fetchContent()` 调 GitHub Contents API raw（拿 Markdown 源码），与代码文件的高亮分流（代码文件直接 Worker 端 highlight.js、文档先渲染 Markdown）。具体的文档/代码分流见
  [媒体代理与 GitHub 渲染](media-github.md)。

`createMarkdownRenderer` 的结果缓存为模块级单例，同 isolate 跨请求复用（`lib/markdown.js:29-30`）。

## 6 两个 bundle 的自我管理

markdown-it.mjs 与 highlight.mjs 不是仓库源文件，而是构建产物。构建细节见 [外置资产与构建部署](assets-and-build.md)：CI / `build.sh` 每次部署时从 jsdelivr / npm 下载源码、用 esbuild 打包成
ESM。Markdown-it 的打包把 `export{Rt as default}` 重写为 `export const MarkdownIt = Rt`，因为它原本是 CommonJS 默认导出为主的库（`build.sh:30-35`）。

两者都是 **Worker 端 SSR 专用**、不下发浏览器：`markdown-it.mjs` 只在 Worker 里把 markdown 渲染成 HTML，`highlight.mjs` 只在 Worker 里把代码块着色成静态 `<span>`；浏览器拿到的已是成品 HTML，零 JS
成本。这一点与外置到 `/assets/` 的浏览器资产（`twitter.css` / `github.css` / `artplayer.js`）职责分明。

## 7 关联

- Markdown 变体的上游改写规则与微信裁剪锚点 → [HTML 与微信文章代理](html-wechat.md)
- R2 绑定 `TWEETS`、AI 绑定 `env.AI` 与零消耗验证 → [存储与 AI 绑定](storage-and-ai.md)
- /github/ 代码块 Worker 端高亮与目录列表 → [媒体代理与 GitHub 渲染](media-github.md)
