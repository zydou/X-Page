---
type: 子系统
title: 内联资产与构建部署
description: 自包含 HTML 的内联资产策略、构建脚本与 CI 部署流水线
tags: [构建部署, 内联资产, CI, Cloudflare Workers]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-05T11:10:10.273Z
sources:
  - id: openwiki-source-d8b6488c252ba22fd6c0f6dc
    resource: repo://.github/workflows/deploy.yaml
  - id: openwiki-source-8a2e26d4137b8250f68bb869
    resource: repo://build.sh
  - id: openwiki-source-68a298210d5ca78ea539a038
    resource: repo://routes/github.js
  - id: openwiki-source-e6d55ef25bd11136cefa6cc4
    resource: repo://routes/video.js
  - id: openwiki-source-1adf5eb6c74462684e873d78
    resource: repo://worker.js
  - id: openwiki-source-8f4419482b64e334cd5f4bb6
    resource: repo://wrangler.toml
generated: { by: "claude-code", at: "2026-11-05T11:10:10.273Z" }
---

# 内联资产与构建部署

本页说明 x-page 如何把所有前端资源内联进自己渲染的 HTML——零外部引用、浏览器零加载 Worker 外资源——以及 `build.sh` 与 CI 流水线如何保证这些资产在部署的 Worker 中可用。部署前请先看 [快速上手](quickstart.md) 的部署一节。

## 1 内联资产：WATER_CSS / TWITTER_CSS / ARTPLAYER_JS / HLJS

> [!NOTE]
> `worker.js:27-31` 导入三份资产并作为参数下发，下游 `video.js`、`tweet.js`、`github.js` 均不自行 import。原因：Wrangler Text module rule 要求 import 必须写在入口文件，子模块用 ESM 导入这些文本模块不可行。

### 1.1 WATER_CSS 与 TWITTER_CSS

- **来源**：`water.css` 由 CI / `build.sh` 从 jsdelivr 的 `water.css@2/out/water.min.css` 拉取（`build.sh:9`）；`twitter.css` 是仓库内手写文件，只写推文专属覆盖样式，不被 build 脚本改动。
- **机制**：Wrangler Text module rule（见 `wrangler.toml:15-18` 的 `[[rules]]`）把 `.css` 当纯文本字符串 import 入 `worker.js`，再作为参数注入 `<style>` 标签。不走 `[assets]` 或任何 CDN 引用。
- **注入位置**：`tweet.js` 的 `renderTweetMarkdown()` 拼 `<style>` 时写 `${WATER_CSS}`；`github.js` 的 `renderRepoHtml()` / `renderDirListing()` 一并注入 `WATER_CSS` 与 `HLJS_THEME_CSS`（`routes/github.js:192-193,375-376`）；`video.js` 同样把 `WATER_CSS` 与 `HLJS_THEME_CSS` 写入 `<style>`（`routes/video.js:206-207`）。

### 1.2 ARTPLAYER_JS

- **来源**：CI / build 时从 jsdelivr 的 `artplayer/dist/artplayer.js` 下载（`build.sh:26`），**禁止用 `esbuild` minify**——minified 源码含反引号 / `${}`，若用 esbuild 压缩后以模板字面量注入，运行时变量展开必出错。正确做法是 `export default JSON.stringify(src)` 包装。
- **现状**：仓库内 `artplayer.mjs` 就是 `build.sh:29-31` 产出的 `export default "..."` 单行文件，`worker.js:28` import 后作为参数传给 `serveVideo`，`video.js` 模板中 `${ARTPLAYER_JS}` 注入 `<script>`。

### 1.3 HLJS（Worker 端代码高亮）

- **产物**：`highlight.mjs` 是 `build.sh:54-75` 打出来的 `highlight.js 11.10.0` core + 15 种内置语言模块 + GitHub 主题 CSS（亮 + 暗两版经 `prefers-color-scheme` 合并），暴露 `highlightCode()` / `highlightWith()` / `BUILTIN_LANGS` / `HLJS_THEME_CSS` 四个具名导出。
- **注入**：`worker.js:37` 以 `import * as HLJS` 拿到后作为参数传给 `serveGithub`；`routes/github.js:150-173` 的 `renderCodeHtml()` 在 **Worker 端**调 `HLJS.highlightCode()` / `highlightWith()` 把 Markdown 代码块渲染成静态 HTML，浏览器零 JS 成本。

### 1.4 为什么坚持「内联」

CLAUDE.md 的 Style Conventions 明写：所有消费者供给的资产必须内联进模板，**禁止在渲染 HTML 中引用外部 origin**。万一将来要新增 CSS 或 JS，先判断它是否够「简单」到值得引入构建管线，否则内联字符串是更小、更可控的选择。

## 2 构建脚本：build.sh

执行 `sh build.sh` 依次做四件事，均为**幂等跳过**（文件已存在即跳过下载，保留本地手工改动）：

1. **CSS**：拉 `water.css`（jsdelivr），esbuild minify（`--legal-comments=none --drop:console --drop:debugger`）；CI=true 时也会 minify `twitter.css`，本地 dev 只压 `water.css`（`build.sh:12-18`，本地跳过的原因是避免本地覆盖手工改好的 twitter.css）。
2. **Artplayer**：拉 `artplayer.js`（jsdelivr），`JSON.stringify` 包装成 `artplayer.mjs`（`build.sh:25-33`）。
3. **markdown-it**：`npm install markdown-it@14.1.0` → esbuild bundle `--format=esm --platform=node --minify` → 把 `export{Rt as default}` 重写成 `export const MarkdownIt = Rt`，产出 `markdown-it.mjs`（`build.sh:38-51`）。本地 `/github/` 的 Markdown 渲染由这个 bundle 支撑，见 [Markdown 转换](markdown.md)。
4. **highlight.js**：下载 core + 15 种语言 min.js 与 GitHub 主题 CSS，拼接成 `highlight.mjs`（`build.sh:54-75`）；最后 `sed` 剥掉 `&&(module.exports=hljs)` 免去 wrangler ESM 警告。

> [!WARNING]
> 步骤 3 / 4 拿完产物后会 `rm -rf node_modules package.json package-lock.json` 清理中间文件（`build.sh:51,137`）。这是本仓库没包管理器、没 node_modules 的前提——CI 跑完 Wrangler 部署就走人。

## 3 CI 部署流水线

`.github/workflows/deploy.yaml` 单 job `deploy`（ubuntu-latest，10 分钟超时），触发条件是 push 到 `worker.js`、`routes/**`、`lib/**`、`twitter.css`、`wrangler.toml`、`build.sh`、或 `workflow_dispatch`。

- **步骤一**：`npx wrangler deploy`。Wrangler 先执行 `wrangler.toml:23-24` 的 `[build].command = "sh build.sh"`，把远端资产全部下载好的前提下部署。
- **步骤二：重开 Worker Cache**。Wrangler deploy 会把 Worker Cache 运行时开关重置为默认（禁用）。CI 用 `CF_API_TOKEN` 调 Account API `/workers/scripts/{name}/settings` 重新 PATCH `settings={"cache_options":{"enabled":true}}`（需 token 具备 Workers Scripts:Edit 权限）。注释里明确说明用 `--config wrangler.dev.toml` 的调试 Worker **不要开这个设置**，免得开发 Worker 和生产 Worker 接管同一 question 缓存键。

> [!TIP]
> **不要等 GitHub Actions 绿灯**。CLAUDE.md 明说 Deploy workflow 经常排队数分钟，正确的验证方式是直接在终端跑 `npx wrangler deploy`（先 dev 后 prod），再 curl 验证每条路由：`/html/`、`/wechat/`、Range 透传等。

## 4 wrangler.toml module rules 必须用 `[[rules]]` 数组表头

### 4.1 踩坑症状

`wrangler.toml` 里写裸字段形式：

```toml
# ❌ 错误：裸字段
rules = [{ type = "Text", globs = ["**/*.css"], fallthrough = true }]
```

wrangler 部署时打印 `Unexpected fields found in r2_buckets[0] field: "rules"`，CSS / 其它 Text 模块没打进 bundle，Worker 里 `import WATER_CSS from "./water.css"` 拿到的是**空对象**，最终 HTML `<style>` 里被渲染成字面量字符串 `[object Object]`——页面布局全乱。

### 4.2 正确写法

**所有 wrangler 配置（prod + dev）一律用 `[[rules]]` 数组表头形式，且把 `[[rules]]` 放在其它 `[[array]]` 块之前**：

```toml
# ✅ 正确：数组表头形式
[[rules]]
type = "Text"
globs = ["**/*.css"]
fallthrough = true
```

本仓库 `wrangler.toml:13-18` 就是这个写法，排在 `[[r2_buckets]]` 之前。任何时候在文件里加 `[[r2_buckets]]` / `[[kv_namespaces]]` 等其它 `[[array]]` 块都要保持这个顺序，并以 `[[rules]]` 开头，而非裸字段。

### 4.3 为什么裸形式偶尔能跑

TOML 规范规定：紧跟 `[[array]]` 项之后、未被更上层 `[table]` 切分之前，裸字段都属于「最近的」那个数组项。所以当文件只有一个裸 `rules` 而无其它 `[[array]]` 块时，它属于顶层 worker-config 表，能正常生效；一旦加入 `[[r2_buckets]]` 且没有 `[table]` 切分，裸 `rules` 就被解析器吞进那个数组项里去，wrangler 报 `r2_buckets[0] field: "rules"`。

### 4.4 验证手段

部署后 `curl` 任意一条路由，看返回 HTML `<head>` 的 `<style>` 里面是真实 CSS 还是 `[object Object]`。是后者说明 rules 被吞了，去查 TOML 顺序。

## 5 部署与验证清单

| 步骤 | 命令 |
|---|---|
| 本地快速验证 | `npx wrangler dev` 后 curl 各路由前缀 |
| dev 部署 | 复制 `wrangler.toml` → `wrangler.dev.toml`，改 `name="x-dev"` 与 dev hostname，`npx wrangler deploy --config wrangler.dev.toml` |
| prod 部署 | `npx wrangler deploy` |
| 验证 | `curl https://<host>/html/<url>`、`/wechat/<url>`、`curl -H "Range: bytes=0-..." /proxy/<url>` 检查 range 透传 |

触发 CI 部署的 push 路径已在 CI yaml 列出，但手动部署同样能走通整条管线——CI 存在的价值是给 supply 链兜底 + push 时自动发布生产 Worker。

## 6 关联

- 路由如何分发这些资产 → [路由与请求处理](routing.md)
- Markdown 渲染管线（markdown-it.mjs / highlight.mjs）为什么走 Worker 端 → [Markdown 转换](markdown.md)
- GitHub README 渲染如何消费 WATER_CSS 与 HLJS → [媒体代理与 GitHub 渲染](media-github.md)
