---
type: 子系统
title: 外置资产与构建部署
description: 自包含渲染的外置 /assets/ 资产策略（immutable 长缓存）、build.sh 构建脚本与 CI 部署流水线
tags: [构建部署, 外置资产, CI, Cloudflare Workers]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-10T10:39:10.208Z
sources:
  - id: openwiki-source-d8b6488c252ba22fd6c0f6dc
    resource: repo://.github/workflows/deploy.yaml
  - id: openwiki-source-8a2e26d4137b8250f68bb869
    resource: repo://build.sh
  - id: openwiki-source-4cc5b54b5fc77565a9fc3760
    resource: repo://lib/markdown.js
  - id: openwiki-source-68a298210d5ca78ea539a038
    resource: repo://routes/github.js
  - id: openwiki-source-e6d55ef25bd11136cefa6cc4
    resource: repo://routes/video.js
  - id: openwiki-source-1adf5eb6c74462684e873d78
    resource: repo://worker.js
  - id: openwiki-source-8f4419482b64e334cd5f4bb6
    resource: repo://wrangler.toml
generated: { by: "claude-code", at: "2026-11-10T10:39:10.208Z" }
---

# 外置资产与构建部署

本页说明 x-page 如何把浏览器可见的 CSS / JS **外置**到 `/assets/<name>`（带 1 年 immutable 缓存），让飞书文档里几十个 iframe 共享一份浏览器 HTTP 缓存，而不是每个 iframe 各自重新下载；以及 `build.sh`
与 CI 流水线如何保证这些资产在部署的 Worker 中可用。部署前请先看 [快速上手](quickstart.md) 的部署一节。

## 1 资产策略：外置 /assets/ 而非内联

> [!NOTE]
> 历史行为是「所有 CSS / JS 内联进渲染 HTML」。commit `a8b397f` 改为外置：Worker 仍通过 Text module 把 CSS / JS 作为字符串导入（`worker.js:36-38`），但不再拼进每个页面的 `<style>` / `<script>`，而是在 `/assets/` 分支统一 serve（`worker.js:121-136`）。原因见第 1.4 节。

### 1.1 Worker 导入三份 Text module

`worker.js:36-38` 通过 wrangler Text module rule 把三份浏览器资产作为字符串导入：

- `artplayer.mjs` → `ARTPLAYER_JS`（`export default "<JSON 转义源码>"`）
- `assets/twitter.css` → `TWITTER_CSS`
- `assets/github.css` → `GITHUB_CSS`

`worker.js:44` 另外以 `import * as HLJS` 导入 `highlight.mjs`，但它是 Worker 端 SSR 渲染用的命名空间，**不下发浏览器**。

### 1.2 /assets/ 分支外置 serve

`worker.js:121-136` 匹配 `assets/` 前缀，按文件名从导入的字符串里取 body，返回时带 `Cache-Control: public, max-age=31556952, immutable`：

| 请求路径               | body 来源      | Content-Type |
| ---------------------- | -------------- | ------------ |
| `/assets/twitter.css`  | `TWITTER_CSS`  | `text/css; charset=utf-8` |
| `/assets/github.css`   | `GITHUB_CSS`   | `text/css; charset=utf-8` |
| `/assets/artplayer.js` | `ARTPLAYER_JS` | `text/javascript; charset=utf-8` |

未命中的资产名返回 404。下游路由用**外链**引用这些资产，不再内联：

- `routes/video.js:98` 用 `<script src="/assets/artplayer.js" defer>` 加载播放器库；
- `routes/github.js:473,514,586` 用 `<link rel="stylesheet" href="/assets/github.css">` 加载文档 / 代码 / 目录页样式（`github.css` 内含裁剪后的 water 子集 + hljs 主题 + `.gh-*`）；
- `routes/tweet.js` 的 `wrapHtml()`（`tweet.js:420-431`）用 `<link rel="stylesheet" href="/assets/twitter.css">` 加载推文样式。

### 1.3 两类资产的分界

- **浏览器资产**（`/assets/` 外置）：`twitter.css`、`github.css`、`artplayer.mjs`。特点是同一个大文档里会出现 N 次，外置后靠浏览器 HTTP 缓存只下载一次。
- **Worker 端 SSR 资产**（不下发浏览器）：`markdown-it.mjs`、`highlight.mjs`。它们只在 Worker 里把 markdown / 源码渲染成静态 HTML，浏览器拿到的已是着色好的 `<span>`，零 JS 成本。

### 1.4 播放器脚本的 defer + DOMContentLoaded 契约

`routes/video.js` 是唯一以 `<script src>` 外链加载 JS 的路由，它对外置库的执行时序有一个必须遵守的契约（`video.js:98-116`）：

1. `<script src="/assets/artplayer.js" defer>` 加载播放器库——`defer` 保证它在 HTML 解析完成之后、`DOMContentLoaded` 事件之前执行；
2. 紧随其后的**内联**初始化脚本包在 `window.addEventListener("DOMContentLoaded", ...)` 里，把 `Artplayer.ASPECT_RATIO` / `PLAYBACK_RATE` 配置和 `new Artplayer({...})` 全部延后到该事件回调。

这个包装不能省。内联脚本会在 HTML 解析到它时**立即**执行，早于任何 `defer` 脚本；若把 `new Artplayer(...)` 直接写在内联脚本顶层，执行时 `Artplayer` 全局还没被库脚本定义，会抛 `ReferenceError`
并渲染成空白页。commit `cea145e` 就是修的这个回归——外置重构 `a8b397f` 把库改成 `defer` 外链后漏了把内联初始化一起延后。

> [!NOTE]
> 凡是以 `defer`（或 `type="module"`，同为 defer 语义）外链加载、又在同一文档里用内联脚本立刻调用的库，都必须把调用包进 `DOMContentLoaded`。`/img/`、`/html/` 等路由的 HTML 不含外链 JS，不受此约束。

### 1.5 为什么从内联改为外置

内联的好处是「页面完全自包含、不受混合内容拦截」；代价是飞书文档里几十个推文 / 仓库 iframe 各自携带一整份 CSS / JS 副本，重复下载 N 次。外置到 `/assets/` 后，同域 + immutable 长缓存让 N 个 iframe
共享一份浏览器缓存。Worker 仍通过 Text module 导入这些字符串（而非引用外部 origin），所以既满足 CLAUDE.md「渲染 HTML 不得引用外部 origin」的约束，又拿到了缓存复用。

## 2 构建脚本：build.sh

`sh build.sh` 依次做四步，前三步**幂等跳过**（产物已存在即跳过下载 / 构建），第四步只做存在性校验：

1. **artplayer.mjs**（`build.sh:6-19`）：从 jsdelivr 拉 `artplayer/dist/artplayer.js`，用 `node -e` 读源码、`JSON.stringify` 包装成 `export default "..."` 单行写入
   `artplayer.mjs`（`build.sh:16`）。**禁止 esbuild minify**——压缩后的源码含反引号 `` ` `` 与占位符 `${`，若以模板字面量注入会被 JS 引擎错误解析；先 `JSON.stringify` 成字符串字面量再作 ESM
   默认导出即可安全内联。
2. **markdown-it.mjs**（`build.sh:21-38`）：`npm install markdown-it@14.1.0 --no-save` → `esbuild --bundle --format=esm --platform=node --minify` 打成自包含 ESM（`build.sh:26-29`）→ 把
   `export{Rt as default}` 重写为 `export const MarkdownIt = Rt`（`build.sh:30-35`），因为它原本以 CommonJS 默认导出为主。给 [Markdown 转换](markdown.md) 的 `/github/` 渲染用。
3. **highlight.mjs**（`build.sh:40-66`）：下载 highlight.js `11.10.0` core + 15 种内置语言 min.js + GitHub 亮 / 暗主题 CSS，拼接成单文件 ESM（`build.sh:54-61`），暴露 `highlightCode()` /
   `highlightWith()` / `BUILTIN_LANGS` / `HLJS_THEME_CSS` 四个具名导出；亮暗两版主题用 `@media (prefers-color-scheme: dark)` 合并。最后 `sed` 剥掉 `&&(module.exports=hljs)` 免去 wrangler ESM
   警告（`build.sh:64-65`）。
4. **assets/github.css 校验**（`build.sh:68-75`）：`assets/github.css` 已提交进仓库（内含裁剪 water 子集 + hljs 主题 + `.gh-*`），脚本只检查它存在，缺失则告警，**不重新生成**。hljs
   主题升级时需手工重新合并。

> [!WARNING]
> 步骤 2 拿完产物后会 `rm -rf node_modules package.json package-lock.json`（`build.sh:36`），步骤结束统一 `rm -f` 中间文件、`rm -rf build/`（`build.sh:78-80`）。这是本仓库没包管理器、没 node_modules 的前提——CI 跑完 Wrangler 部署就走人。

**注意**：`assets/twitter.css` 与 `assets/github.css` 已提交进仓库、**不被 build.sh 改动**；旧的根目录 `water.css` 拉取 / minify 步骤已随外置重构移除。

## 3 CI 部署流水线

`.github/workflows/deploy.yaml` 单 job `deploy`（ubuntu-latest，10 分钟超时），触发条件是 push 到 `worker.js`、`routes/**`、`lib/**`、`assets/**`、`wrangler.toml`、`build.sh`、`deploy.yaml`，或手动
`workflow_dispatch`。

- **步骤一**（`deploy.yaml:27`）：`npx wrangler deploy`。Wrangler 先执行 `wrangler.toml` 的 `[build].command = "sh build.sh"`，把远端资产全部构建好再部署。
- **步骤二：重开 Worker Cache**（`deploy.yaml:33-48`）。Wrangler deploy 会把 Worker Cache 运行时开关重置为默认（禁用）。CI 用 `CF_API_TOKEN` 调 Account API `/workers/scripts/{name}/settings` 重新
  PATCH `settings={"cache_options":{"enabled":true}}`（`deploy.yaml:47`，需 token 具备 Workers Scripts:Edit 权限），并校验响应里 `cache_options.enabled` 为 true 否则退出非零。

> [!TIP]
> **不要等 GitHub Actions 绿灯**。CLAUDE.md 明说 Deploy workflow 经常排队数分钟，正确的验证方式是直接在终端跑 `npx wrangler deploy`（先 dev 后 prod），再 curl 验证每条路由：`/html/`、`/wechat/`、Range 透传等。CI 的价值是 push 时自动发布 + supply 链兜底。

## 4 wrangler.toml module rules 必须用 `[[rules]]` 数组表头

### 4.1 踩坑症状

`wrangler.toml` 里写裸字段形式：

```toml
# ❌ 错误：裸字段
rules = [{ type = "Text", globs = ["**/*.css"], fallthrough = true }]
```

wrangler 部署时打印 `Unexpected fields found in r2_buckets[0] field: "rules"`，CSS / 其它 Text 模块没打进 bundle，Worker 里 `import TWITTER_CSS from "./assets/twitter.css"`
拿到的是**空对象**，`/assets/` 返回的 CSS 变成字面量 `[object Object]`——页面样式全丢。

### 4.2 正确写法

**所有 wrangler 配置（prod + dev）一律用 `[[rules]]` 数组表头形式，且把 `[[rules]]` 放在其它 `[[array]]` 块之前**：

```toml
# ✅ 正确：数组表头形式
[[rules]]
type = "Text"
globs = ["**/*.css"]
fallthrough = true
```

本仓库 `wrangler.toml` 就是这个写法，排在 `[[r2_buckets]]` 之前。任何时候在文件里加 `[[r2_buckets]]` / `[[kv_namespaces]]` 等其它 `[[array]]` 块都要保持这个顺序，并以 `[[rules]]` 开头，而非裸字段。

### 4.3 为什么裸形式偶尔能跑

TOML 规范规定：紧跟 `[[array]]` 项之后、未被更上层 `[table]` 切分之前，裸字段都属于「最近的」那个数组项。所以当文件只有一个裸 `rules` 而无其它 `[[array]]` 块时，它属于顶层 worker-config
表，能正常生效；一旦加入 `[[r2_buckets]]` 且没有 `[table]` 切分，裸 `rules` 就被解析器吞进那个数组项里去，wrangler 报 `r2_buckets[0] field: "rules"`。

### 4.4 验证手段

部署后 `curl https://<host>/assets/twitter.css`，看返回的是真实 CSS 还是 `[object Object]`。是后者说明 rules 被吞了，去查 TOML 顺序。

## 5 部署与验证清单

| 步骤         | 命令 |
| ------------ | ---- |
| 本地快速验证 | `sh build.sh` 后 `npx wrangler dev`，curl 各路由前缀与 `/assets/twitter.css` |
| dev 部署     | 复制 `wrangler.toml` → `wrangler.dev.toml`，改 `name="x-dev"` 与 dev hostname，`npx wrangler deploy --config wrangler.dev.toml` |
| prod 部署    | `npx wrangler deploy` |
| 验证         | `curl https://<host>/assets/twitter.css` 看 CSS 是否真实；`/html/<url>`、`/wechat/<url>`、`curl -H "Range: bytes=0-..." /proxy/<url>` 检查 range 透传 |

触发 CI 部署的 push 路径已在 CI yaml 列出，但手动部署同样能走通整条管线。

## 6 关联

- 路由如何分发请求与 `/assets/` 分支的位置 → [路由与请求处理](routing.md)
- Markdown 渲染管线（markdown-it.mjs / highlight.mjs）为什么走 Worker 端 → [Markdown 转换](markdown.md)
- `/github/` 如何消费 `/assets/github.css` 与 highlight → [媒体代理与 GitHub 渲染](media-github.md)
- 推文页如何消费 `/assets/twitter.css` → [推文服务](tweet.md)
