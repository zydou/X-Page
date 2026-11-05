---
type: 子系统
title: 媒体代理与 GitHub 渲染
description: 介绍媒体代理与 GitHub 文件渲染子系统的实现细节
tags: [媒体代理, 视频, 图片, GitHub, Range透传]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-05T11:10:10.273Z
sources:
  - id: openwiki-source-68a298210d5ca78ea539a038
    resource: repo://routes/github.js
  - id: openwiki-source-ccd97eada477a5bd6ef5999b
    resource: repo://routes/proxy.js
  - id: openwiki-source-e6d55ef25bd11136cefa6cc4
    resource: repo://routes/video.js
generated: { by: "claude-code", at: "2026-11-05T11:10:10.273Z" }
---

# 媒体代理与 GitHub 渲染

x-page 最实用的两组能力：四条媒体 / 视频 / 图片子路由，以及 `/github/` 的仓库文件与 README 渲染。

## 1 /proxy/ 通用媒体代理

`routes/proxy.js` 是所有媒体代理的底座。`handleProxy()` 取路径中编码后的 URL 解码、补 `http://` 前缀（裸域名容错），校验后回源（`routes/proxy.js:38-70`）。

### 1.1 Range 透传与缓存头

- **透传 Range**：请求带 `Range` 头时原样转发给上游——视频拖拽播放必需（`routes/proxy.js:58-61`）。
- **CDN 缓存**：`cf: { cacheTtl: 31556952, cacheEverything: true }` 声明响应可进边缘缓存，缓存键 = 完整 URL + vary 头（`routes/proxy.js:63-70`）。下游写死 1 年 immutable 缓存，基于内容 hash 的媒体 URL 一旦写入就不变（`routes/proxy.js:91`）。
- **Content-Disposition 覆盖**：强制 `inline`，上游若返回 `attachment` 也会被盖成内联展示（`routes/proxy.js:93`）。
- **CORS**：`access-control-allow-origin: *` 放宽跨子域，让 HTML 内 `<img>` / `<video>` 能呈现。
- **不设 platform fetch 超时**：大视频回源慢时让 Cloudflare 自带约 100s 超时兜底，自己不抢跑，避免误杀慢速合法源（`routes/proxy.js:27-28`）。

### 1.2 JS / CSS 内容改写

`/proxy/` 不只做 HTML 改写，也**改写 JS/CSS 的相对 URL**（`routes/proxy.js:95-116`）：

- 判断 `content-type` / 后缀 `.js/.mjs` / `.css`。
- `rewriteJsRelativeUrls()` 处理 Vite 常见的三种相对导入写法：`import("./x.js")`、`from "./x.js"`、`export ... from "./x.js"`，箭头指向绝对 `/proxy/<abs>` 路径（`routes/proxy.js:131-150`）。
- `rewriteCssRelativeUrls()` 处理 `url("...")` 引用（`routes/proxy.js:155-161`）。
- 改写后删除 `content-length`，因为内容已变。

原因是 `.html` 路由的 HTMLRewriter 把 `<script src>` 原始域名换成 worker 域名后，Vite 产物内部的相对 chunk 导入按原域名解析会错位——内容改写统一把它们归一到 `/proxy/` 绝对路径。

### 1.3 协议校验

目标只允许 `http(s)://`，缺协议头自动补 `http://`（`routes/proxy.js:52-56`）。

## 2 /vid/ 视频与 /img/ 图片子路由

`routes/video.js` 与 `routes/image.js` 都是壳：解析路径、决定代理还是直连、拼自包含 HTML。**两者的实际字节走 `/proxy/`**，只有直连模式（`/vid/d/`、`/img/d/`）才放原始 URL。

### 2.1 /vid/ 视频

- `serveVideo()` 区分 `/vid/`（代理模式 → `/proxy/<encoded>`，走 Worker 缓存 + 防盗链绕过）与 `/vid/d/`（直连原始 URL，适用无防盗链场景）（`routes/video.js:51-86`）。
- 无 URL 时返回使用说明页；有 URL 时返回 Artplayer HTML，**Artplayer JS 直接内联进 `<script>`**，自包含（`routes/video.js:88-117`）。
- Artplayer 资产由 `worker.js` 入口 Text module 注入，`video.js` 不 import（`routes/video.js:13-15`；见 [内联资产与构建部署](assets-and-build.md) 第 1 节），便于单独测试与热替换。

### 2.2 /img/ 图片

- `serveImage()` 同理区分 `/img/`（代理）与 `/img/d/`（直连）（`routes/image.js:33-66`）。
- 返回极简自适应 HTML：全屏居中展示、`16/9` 等比、图片被 `<a target="_blank">` 包裹可点开原图（`routes/image.js:68-80`）。
- 代理模式依赖 `/proxy/` 路由「剥离 `Content-Disposition: attachment`」——上游强制下载的 URL 经过 `/proxy/` 后改成 `inline` 才会在浏览器里呈现（`routes/image.js:9-10`）。

## 3 /github/<user>/<repo>[/<path>]

`routes/github.js` 让 Worker 作为中立客户端拉 GitHub Contents API、再把内容渲染成自包含 HTML。设计取舍：**走 raw 源码 + markdown 渲染，而不是 `github.html` accept**——`github.html` 会把 img src 转成 `private-user-images` 的 JWT URL（几分钟失效，但 HTML 缓存 5 分钟 → 图片死链）；raw 路线下 GitHub 把外部图走 camo 代理（稳定）且保留干净 URL，彻底解决图片过期（`routes/github.js:12-17,261-266`）。

### 3.1 输入形态：`@ref` 与分支名含斜杠

- 路径形如 `/github/<user>/<repo>[/@<ref>[/<path>]]`（`routes/github.js:731-739`）。
- `ref` 可以是分支、tag 或 commit SHA。
- 分支名含 `/` 时编码（如 `feat%2Fserver_team`）：检测 `@` 在原始 pathname（未 decode）上完成，`%2F` 因此仍是一个段位、不被 `/` 错误分割（`routes/github.js:768-789`）。
- 路径穿越防护：任意 `..` 段位直接 400（`routes/github.js:792-794`）。
- `ref` 非默认时拼 `?ref=` 给 Contents API、`raw.githubusercontent.com` 也拼分支名进 URL（`routes/github.js:273-278`）。

### 3.2 文档 vs 代码文件分流

`serveGithub()` 按文件类型分三路（`routes/github.js:798-856`）：

- **代码文件**（扩展名映射表 `CODE_LANG` 覆盖 34 种语言，`routes/github.js:67-86`）：走 `raw.githubusercontent.com` 拉 raw 源码，Worker 端用 highlight.js `hljs.highlight()` 纯函数产出着色静态 HTML，**浏览器零 JS**。内置 15 种核心语言；其余语言按需 fetch 语言模块后注册再高亮（`highlightWith()`），缓存进同 isolate 的 `LANG_MODULE_CACHE`（`routes/github.js:364-374`）。主题 CSS（GitHub light + dark）内联到 `<style>`，`prefers-color-scheme` 自动切换。
- **文档**（`.md/.rst/.org` 等，`DOC_EXTS`）：走 GitHub Contents API raw（拿 Markdown 源码）→ Worker 端 markdown-it 渲染（`lib/markdown.js`，代码块由 highlight.js 着色）→ HTMLRewriter 代理图片与媒体。
- **目录**：GitHub 对目录返回 JSON 数组，渲染文件列表页（目录优先、文件次之、各自按名排序）。

仓库元数据（owner 头像、star / fork / watching）与内容并行发出（`Promise.all`），不增加往返（`routes/github.js:209-239`）。

### 3.3 图片改写：`data-canonical-src` 优先

文档路径的 `buildRewriter()` 用 HTMLRewriter 改写 `<img>` / `<video>` / `<source>` / `<a>`：

- `<img>` **优先取 `data-canonical-src`**（GitHub 对 camo 代理图的真实源 URL，如 shields.io），没有再用 `src`（`routes/github.js:172-182`）。
- 相对路径统一用 `resolveUrl()` 按 `raw.githubusercontent.com/{owner}/{repo}/{ref}/{fileDir}` 解析——文件所在目录必须算进 base，否则 `readme/README.zh-CN.md` 里 `../assets/x.png` 会把分支名那层吃掉、raw 404（`routes/github.js:146-152`）。
- `<a>` 只改写相对路径的资源链接为 `/proxy/<resolved>`，避免图片被 `<a href="assets/x.png">` 包裹时点击解析到不存在的 `/github/.../assets/x.png`；绝对外部链接保持原样直接跳转（`routes/github.js:190-199`）。

### 3.4 代码高亮的按需语言模块

代码文件高亮三层兜底（`routes/github.js:388-402`）：

1. **内置语言**（`BUILTIN_LANGS`，15 种）→ 直接 `highlightCode()`。
2. **非内置** → 内存缓存 miss 时从 jsdelivr 按需 fetch 语言模块源码，经 `highlightWith(value, language, source)` 用 `new Function("hljs", source)(hljs)` 注册后高亮（`routes/github.js:364-374`）。
3. **超长源码**（`> CODE_MAX_CHARS = 200000` 字符）或高亮失败 → 退化为纯文本 `<pre>`。

### 3.5 限流与错误处理

无 `GITHUB_TOKEN` 时 GitHub API 60 次/h；配置 `GITHUB_TOKEN` 可提至 5000/h。目录与文件都 `cf: { cacheTtl: 300, cacheEverything: true }` 有 5 分钟边缘缓存减轻 API 压力（`routes/github.js:280-283`）。错误页统一拼自包含错误页，含「在 GitHub 查看」跳转。

## 4 /github/ 渲染细节与错误兜底

- 文档页与代码页共用 `.gh-topbar` 头：左 owner / repo / path 路径、右 Watch / Star / Fork 胶囊（`renderTopbar`，`routes/github.js:415-446`）。
- 文档路径用 `wrapDocPage` 包裹：`water.css` 基础排版 + markdown 容器约束（`markdown-body` 样式）+ highlight 主题 CSS（`routes/github.js:465-516`）。
- 失败回退：HTMLRewriter 改写失败时降级返回原始渲染 HTML（`routes/github.js:863-869`）。

## 5 关联

- Markdown 渲染的 markdown-it 管线与 Worker/highlight 分工 → [Markdown 转换](markdown.md)
- /github/ 用到的 WATER_CSS / HLJS 资产从哪来 → [内联资产与构建部署](assets-and-build.md)
- GitHub 链接怎么触发这些路由 → [Telegram 机器人](bot.md) 第 4 节
