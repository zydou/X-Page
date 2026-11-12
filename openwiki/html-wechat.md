---
type: 子系统
title: HTML 与微信文章代理
description: 梳理 HTML 抓取改写代理与微信公众号文章代理的实现与差异
tags: [HTML代理, 微信公众号, 改写, HTMLRewriter]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-12T05:54:32.565Z
sources:
  - id: openwiki-source-27c2f4f82d56c7b2c6f3a601
    resource: repo://lib/site-hacks/index.js
  - id: openwiki-source-49a29538c856baffc5474e52
    resource: repo://lib/site-hacks/openrouter.js
  - id: openwiki-source-191ac1117a045536f59c18b2
    resource: repo://routes/html.js
  - id: openwiki-source-3e61b3820564ba3d588667cf
    resource: repo://routes/wechat.js
generated: { by: "claude-code", at: "2026-11-12T05:54:32.565Z" }
---

# HTML 与微信文章代理

`/html/<encoded>` 是通用 HTML 抓取改写代理，`/wechat/<encoded>` 是专为微信公众号文章定制的兄弟路由。两者共享抓取流水线，差异仅在标题链接包装、Markdown 变体清理与 R2 缓存策略上。

相关：Markdown 变体的完整生成链路见 [Markdown 转换](markdown.md)；路由排队顺序见 [路由与请求处理](routing.md)。

## 1 /html/ 通用 HTML 代理

入口是 `serveHtml()`（`routes/html.js:370`，签名 `(request, env, ctx, transform, prefix, mdNs)`）。解析 URL 编码后缺失直接 400，解码失败 400，缺失 `http(s)://` 前缀自动补 `http://`（`routes/html.js:373-383`）。

### 1.1 抓取UA 与防盗链

- 默认 UA 是 iOS 微信内置浏览器 UA（`DEFAULT_UA`，`routes/html.js:45-48`），可由 `wrangler.toml [vars] UA` 覆盖（`ua = env.UA || DEFAULT_UA`，`routes/html.js:385`）。
- `fetchUpstream()` 统一发自定义 UA + 自家域名的 Referer（`routes/html.js:255-263`），因为微信图片有 `Referer` 校验；Worker 发请求天然不带 Referer，可以绕过微信图片防盗链（`routes/html.js:31-33`）。
- 上游非 OK 直接透传状态码给客户端；非 `text/html` 按原样回流、不做改写（`routes/html.js:392-394`）。

### 1.2 HTMLRewriter 改写规则表

`buildRewriter()` 用 Cloudflare 原生 `HTMLRewriter`（流式、零依赖、自动实体解码）处理所有资源（`routes/html.js:122-230`）。

| 处理对象                               | 改写属性                    | 目标 |
| -------------------------------------- | --------------------------- | ---- |
| `img` / `source`                       | `src`、`data-src`、`srcset` | `/proxy/<abs>` |
| `video`                                | `src`、`poster`             | `/proxy/<abs>` |
| `audio` / `embed` / `track` / `iframe` | `src`                       | `/proxy/<abs>` |
| `script`                               | `src`                       | `/proxy/<abs>` |
| `link`                                 | `href`                      | `/proxy/<abs>` |
| `object`                               | `data`                      | `/proxy/<abs>` |
| `a`                                    | `href`                      | `/html/<abs>`（相对路径先按原文域名解析） |
| `style` 块与内联 `style`               | `url(...)`                  | `/proxy/<abs>` |

`shouldProxy()` 排除 `data:` / `blob:` / `javascript:` / `#` 锚点，且已有 `/proxy/` 前缀的不再二次包裹（`routes/html.js:72-80`）；`<a>` 已有 `/html/` 前缀的不再重复处理（`routes/html.js:200-209`）。

`proxyAttr()` 对普通属性做「相对路径按被代理页 URL 解析 → 包 `/proxy/` 前缀」的两步（`routes/html.js:131-135`），`proxySrcset()` 把 srcset 的每个条目逐一处理。

### 1.3 懒加载兜底

`<img>` / `<source>` 若 `src` 为空而有 `data-src`，把 `data-src` 复制给 `src`；`srcset` 是唯一资源时取最后一项（通常是最清晰的一档），并且此时 srcset 已被 `proxySrcset` 写成 `/proxy/`
路径（`routes/html.js:174-190`）。这是一个 Markdown 管线必需补救——Workers AI `toMarkdown` 会丢弃只有 `data-src` 的图片和 srcset，实测微信正文 9 张懒加载图全跑不出来，对 HTML 管线无害（浏览器有 srcset
时仍以 srcset 为准）。

### 1.4 流式输出与改写失败降级

无后处理钩子**且不命中站点 hack** 时走流式：`rewriter.transform()` 直接把响应流改写后返回，零额外内存。
一旦命中站点 hack（`resolveSiteHack(host)` 返回非空）或带 transform 钩子（如 `/wechat/`），则先 `await transformed.text()` 把整篇缓冲成字符串、应用 `applySiteHack` 后再返回——hack 需要完整 HTML 才能整篇正则中和。
如果改写抛异常，重新抓取一次上游、原样回退给用户，至少保住页面能看，**降级路径同样要上站点 hack**，否则命中站点会重新暴露反镜像跳转（`routes/html.js:416-446`）。

响应统一头 `content-type: text/html`——刻意去掉 `charset`，因为 HTMLRewriter 不接受显式字符集，否则抛 `Unknown character encoding`（`routes/html.js:400-404`）。每条响应带 `Vary: Accept`，区分 HTML 与
Markdown 两种表示。

### 1.5 站点专属 hack：lib/site-hacks/

`/html/` 是通用代理，但个别站点在客户端做反镜像检测、强制跳转或污染渲染，通用规则解决不了，只能按站点精确中和。`lib/site-hacks/` 按「一站点一文件」存放这些 hack，各自隔离。

注册表 `lib/site-hacks/index.js` 导出两个函数：

- `resolveSiteHack(host)`：按 host 命中 `HACKS` 数组里第一个 `matches(host)` 为真的模块，未命中返回 `null`。
- `applySiteHack(html, hack)`：命中则调 `hack.sanitize(html)` 整篇中和，未命中原样返回。

每个 hack 模块导出 `matches(host) => boolean` 与 `sanitize(html) => string`。
当前唯一实现 `openrouter.js`：openrouter.ai 页面内联了一段「反镜像」脚本，客户端判断 `window.location.hostname` 不在自家白名单就用 `location.replace()` 把页面赶回原站，经代理后只留一屏骨架占位。
`sanitize` 用正则 `/<script>\(function\(\{location:a,navigator:b\},c\)[\s\S]*?<\/script>/g` 干掉可执行的反镜像脚本（替换成无害占位），并移除指向原站的 `<link rel="canonical">`（`lib/site-hacks/openrouter.js:49-78`）。

两个关键取舍，也是整个目录的设计理由：

- **为什么整篇字符串后处理，而不是往 HTMLRewriter 挂 text 处理器**：要中和的往往是 `<script>` 的「内容」。
  而 HTMLRewriter 是流式的——script 正文被切成多个 text chunk，标记可能正好跨在 chunk 边界导致 `includes()` 落空；且内容一旦流式输出就无法用 `remove()` 撤回。
  缓冲好的完整字符串做正则整段替换对这两点都免疫。
- **为什么只中和「可执行的那一份」**：openrouter 的反镜像代码在页面里出现多次，但只有两种形态。
  一种是独立的未转义 `<script>`（真正会 `location.replace` 跳转，必须中和）。
  另一种是 Next.js flight payload `self.__next_f.push(...)` 里已转义的数据副本（`\"mirror-host-report\"` 字面量，只是数据，正是它 hydration 渲染出正文）。
  正则特意锚定 `<script>(function({location:a,navigator:b},c)` 这个未转义开头，只命中前者；flight payload 以 `self.__next_f.push` 开头且已转义，天然不匹配，得以保留——删了它页面就永远停在骨架屏。

buildRewriter 本身不感知 hack，`resolveSiteHack` + `applySiteHack` 由 `serveHtml` 的三条缓冲路径（Markdown 管线 / 主 HTML 缓冲路径 / 改写失败降级）在缓冲出完整 HTML 后调用。

## 2 /wechat/ 微信公众号专用代理

`serveWechat()`（`routes/wechat.js:181-249`）整体复用 `serveHtml()`，差异三处：

### 2.1 标题包原文链接

`wrapTitleLink()` 用正则在 `transform` 钩子中给 `<h1 id="activity-name">` 正文包上 `<a href="原文URL" target="_blank">`（`routes/wechat.js:106-113`），颜色 `#0076d1` 与 `water.css --links`
对齐、与推文作者链接同色，方便嵌入环境点标题回原文。非微信页面不命中兜底逻辑、不报错（`routes/wechat.js:15-16`）。

### 2.2 R2 永久缓存（wechat 前缀）

微信路由独有 R2 缓存：键 `wechat/<原文URL>`，命中直接返回缓存 HTML，**不做应用层过期判断**，即使原文被删除链接依然可读（`routes/wechat.js:202-222`）。

- 写回经 `ctx.waitUntil` 后台执行，失败静默忽略（`routes/wechat.js:233-237`）。
- `wechat/` 前缀**未配置生命周期过期规则，永久保留**（`routes/wechat.js:34`）；R2 key 直接用原文 URL（支持 UTF-8）。
- 边缘缓存 `no-store`：R2 已是永久真相源，边缘副本在本账号 purge 不掉，「省一次 Worker 调用」换「写坏一次永久错」不划算（`routes/wechat.js:30-31,239-245`）。
- 响应 `x-cache: hit / miss` 标记命中状态。
- **无 refresh 入口**：命中即缓存，内容以首次抓取为准（`routes/wechat.js:173`）。Markdown 变体另有独立 key 与 refresh 语义，见 [Markdown 转换](markdown.md)。
- `/html/` 本身**不**缓存，只 `/wechat/` 生效（`routes/wechat.js:33`）。

### 2.3 Markdown 变体的两块裁剪

`transformWechat(html, target, isMarkdown)`（`routes/wechat.js:157-161`）只在 `isMarkdown=true` 时裁掉两块微信客户端注入、用户看不见但 `toMarkdown` 会整段抽出的 DOM（HTML
视图保留它们以维持「完整渲染原文」语义）：

- **页脚 chrome**：从 `<div id="js_tags_preview_toast">` 切断，之后是底部工具栏（修改于 / 不喜欢）、二维码弹窗、分享面板等（`cutWechatFooter()`，`routes/wechat.js:121,127`）。
- **小说阅读器推广卡片**：从 `<div id="js_novel_card">` 切到 `#js_content` 开标签，卡片闭合标签紧贴正文容器、不需要数 div
  深度；再往前的署名（`#meta_content`、`#js_profile_card`）不在切片范围内，按要求保留（`cutWechatNovelCard()`，`routes/wechat.js:122,137`）。

锚点全部用微信客户端 JS 钩子 id，不用文案——文案会改，id 是客户端代码要抓的节点。

### 2.4 协商顺序

- `Accept: text/markdown` 时**必须先短路**直接交给 `serveHtml` 的独立 Markdown 管线，绕开 R2 命中分支——否则缓存 HTML 会被无视 Accept 直接回给 Markdown 客户端（`routes/wechat.js:195-199`）。
- 否则查 R2 命中直接返回；未命中复用 `serveHtml` 抓取+改写后写回。

### 2.5 HTML 视图保留 chrome

HTML 视图里 `js_tags_preview_toast` 与 `js_novel_card` 本来就是 `display: none`，保留它们才能维持「完整渲染原文」语义；删的是只有 Markdown 转换用不上的两块。这样 `serveHtml` 的 transform 钩子必须接收
`isMarkdown` 布尔参数区分两种管线（`routes/wechat.js:157`）。

## 3 /r2-html/ HTML 视图的 R2 持久缓存变体

`/r2-html/<encoded>` 与 `/html/` 功能完全一致，唯一差异是 **HTML 视图多一层 R2 持久缓存**——原文失效（被删 / 改版）后链接依然可读，内容以首次抓取为准，且重复访问省一次上游抓取。
实现是 `serveR2Html()`（`routes/html.js:477-548`），复用 `serveHtml(前缀 "/r2-html/")` 的抓取与改写，自己只管缓存这一层。

### 3.1 两条管线分开看

- **HTML 视图**：`serveR2Html` 负责，R2 key = `html/<原文URL>`（`routes/html.js:498`）。先查 R2 命中直接返回缓存；miss 才走 `serveHtml` 抓取+改写，把最终 HTML 用 `ctx.waitUntil` 后台写回 R2，失败静默忽略（`routes/html.js:500-520,533-538`）。
- **Markdown 变体**：短路给 `serveHtml` 自带的 `serveMarkdown`，R2 key 为 `md/html/<target>`，与 `/html/` 共用——两条路由的 Markdown 产物相同（都无 transform）。
  命名空间由调用方通过 `mdNs` 参数显式传入（`routes/html.js:282,287`），不从路由前缀推导； 它与 HTML 视图的 `html/` 缓存互不干扰（`routes/html.js:491-494`）。

Markdown 协商**必须先短路**：下面 R2 命中分支会无视 `Accept` 直接返回缓存 HTML，否则一个要 Markdown 的客户端会拿到 HTML。

### 3.2 缓存语义（沿用 /wechat/）

- R2 是永久真相源，命中不做应用层过期判断。
- **无 refresh 入口**：命中即缓存，内容以首次抓取为准（防失效优先）。这一点与 `/html/` 的 Markdown 变体不同，后者 `?refresh=1` 可强制重转。
- 只缓存 `text/html` 响应；Markdown 变体与非 HTML 透传（文件下载 / 纯文本）不进 `html/` 前缀（`routes/html.js:529`）。
- 写回不阻塞响应（`ctx.waitUntil` 后台），失败静默忽略。
- 边缘 `no-store`：R2 已是永久真相源，边缘副本在本账号 purge 不掉，留着不划算；`Vary: Accept` 仍带上（同一 URL 也有 text/markdown 变体）。
- 响应 `x-cache: hit / miss` 标记命中状态（`routes/html.js:513,546`）。

`/html/` 本身**不**缓存 HTML 视图；只有 `/r2-html/` 与 `/wechat/` 的 HTML 视图落 R2。三者与 Markdown 变体的缓存差异见 [存储与 AI 绑定](storage-and-ai.md)。

## 4 未实现：微信公众号视频代理

`routes/wechat.js:36-95` 头注记录了视频不可代理的四层鉴权结论，可以简单归纳为：

- 文章 iframe 懒加载 → 播放器模板 JS 按 `vid` 动态请求视频信息接口 → 返回 `mpvideo.qpic.cn` 的带 `dis_t` 鉴权 mp4 URL（token 有效期约 5 分钟）。
- 方案 A（代理 mp4）需要逆向签名算法，且 mp4 在 HTTP 上裸访 403、token 短命，成本高。
- 方案 B（保留原文 iframe）被播放器模板的 `document.referrer` 白名单挡住（只允许 qq.com / woa.com / oa.com），Worker 域名恒不匹配，iframe 空壳。

当前结论：不值得做，视频在微信文章里保持静默失效。

## 5 关联

- Markdown 变体完整链路与 R2 key 隔离 → [Markdown 转换](markdown.md)
- R2 绑定 `TWEETS` 与生命周期规则 → [存储与 AI 绑定](storage-and-ai.md)
- 微信与 HTML 的共用抓取策略为什么需要自家 UA → [路由与请求处理](routing.md)
- 通用 URL 在 Telegram bot 里如何同时给出 `/html/` 与 `/r2-html/` → [Telegram 机器人](bot.md)
