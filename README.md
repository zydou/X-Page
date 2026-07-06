# X-Page

将 X/Twitter 推文（含 Thread 和 Article）转换为自包含 HTML 页面的 Cloudflare Worker。

此外，本Worker也支持任意http(s)链接的视频代理、图片代理、通用资源代理。

## 功能

### 🐦 X / Twitter 推文 → HTML

```txt
https://<your-worker-domain>/{username}/status/{tweet_id}
```

- 支持推文和 Thread（串推）的完整渲染
- 支持 Twitter Article（长文章，含标题、引用、列表、代码块、粗体/斜体等）
- 自动展开推文中的链接
- 支持图片画廊和视频渲染，带横屏检测、视频懒缓冲
- 支持引用推文（Quote Tweet）及其文章预览
- 可选翻译目标语言
- 内置媒体代理：图片/视频经 Worker 服务端回源流式转发，无需任何外部代理即可在无法直连 Twitter 的地区使用

### 🎬 视频代理

```txt
https://<your-worker-domain>/vid/<URLEncode(视频URL)>
```

- 通过 Worker 代理视频流，绕过大多数视频站的防盗链与跨域限制
- 完整透传 Range 请求头，支持拖拽播放
- 通过 CDN 缓存 1 年，加速二次加载
- 直连模式：`https://<your-worker-domain>/vid/d/<视频URL>`（不经代理）

### 🖼️ 图片代理

```txt
https://<your-worker-domain>/img/<URLEncode(图片URL)>
```

- 剥离 `Content-Disposition: attachment`，强制以内联方式展示
- 自适应缩放 + `object-fit: contain`，在固定比例预览窗格内完整查看
- CDN 缓存 1 年
- 直连模式：`https://<your-worker-domain>/img/d/<图片URL>`

### 🔗 通用资源代理

```txt
https://<your-worker-domain>/proxy/<URLEncode(URL)>
```

直接透传任意 `http(s)://` 资源，附带 CORS 和 1 年缓存。

## 部署

### 前置条件

- Node.js + Wrangler CLI
- Cloudflare 账号与 API Token

### 环境变量（wrangler.toml `[vars]`）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TIMEZONE` | `Asia/Shanghai` | 时区，用于推文时间显示 |
| `TRANSLATE_TO` | `zh-cn` | 推文翻译目标语言（BCP-47），留空则返回原文 |

### 本地开发

```bash
# 1. 拉取并压缩 CSS
curl -fsSL https://cdn.jsdelivr.net/npm/water.css@2/out/water.min.css -o water.css
npx esbuild *.css --minify --legal-comments=none --drop:console --drop:debugger --outdir=. --allow-overwrite

# 2. 拉取 artplayer.js 并包装为 ES module
curl -fsSL https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js -o artplayer.js
node -e '
const fs = require("fs");
const src = fs.readFileSync("artplayer.js", "utf8");
fs.writeFileSync("artplayer.mjs", "export default " + JSON.stringify(src) + ";\n");
'

# 3. 本地开发
npx wrangler dev
```

> 为什么不直接用 `esbuild artplayer.js --minify`？
> 因为压缩后的源码里包含反引号 `` ` `` 和占位符 `${`，直接内联进模板字面量会被 JS 引擎错误解析。
> 先把整段源码 `JSON.stringify` 成一个字符串字面量再作为 ESM 默认导出导入，即可安全地作为字符串值内联。

### 自动部署

推送以下文件的变更至 `main` 分支时，GitHub Actions 会自动拉取依赖、包装资产、压缩 CSS 并部署：

- `worker.js`
- `twitter.css`
- `wrangler.toml`
- `.github/workflows/deploy.yaml`

也可手动在 Actions 页面触发 `workflow_dispatch`。

## 技术栈

- **运行时：** Cloudflare Workers
- **语言：** 纯 JavaScript（ES Module），无构建步骤，零依赖
- **上游 API：** [FxEmbed](https://github.com/FxEmbed/FxEmbed)（获取推文数据）
- **基础样式：** [water.css](https://github.com/kognise/water.css)（在 CI 中下载并内联）
- **自定义样式：** `twitter.css`（覆盖 water.css 的推文布局样式）

## License

[MIT](LICENSE)
