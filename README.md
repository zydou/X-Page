# X-Page

将 X/Twitter 推文（含 Thread 和 Article）转换为自包含 HTML 页面的 Cloudflare Worker。

## 功能

- 支持推文和 Thread（串推）的完整渲染
- 支持 Twitter Article（长文章，含标题、引用、列表、代码块、粗体/斜体等）
- 自动展开推文中的链接
- 支持图片画廊和视频渲染，带横屏检测、视频懒缓冲
- 支持引用推文（Quote Tweet）及其文章预览
- 可选翻译目标语言
- 内置媒体代理：Worker 服务端拉取原始图片/视频流式转发给浏览器，无需任何外部代理即可在无法直连 Twitter 的地区使用

## 使用方法

部署后，访问以下两种等价的 URL 格式：

```txt
https://your-domain.com/{username}/status/{tweet_id}
https://your-domain.com/{tweet_id}
```

例如：

```txt
https://your-domain.com/SpaceX/status/2072464558732824680
https://your-domain.com/2072464558732824680
```

根路径 `/` 会返回使用说明页面。

## 部署

### 前置要求

- 安装 [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
- Cloudflare 账号和 API Token

### 配置环境变量

在 `wrangler.toml` 的 `[vars]` 节中配置：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TIMEZONE` | `Asia/Shanghai` | IANA 时区，用于日期显示 |
| `TRANSLATE_TO` | `zh-cn` | 翻译目标语言（BCP-47），留空则返回原文 |

### 本地部署

```bash
wrangler deploy
```

### 自动部署（GitHub Actions）

仓库已配置 CI/CD（`.github/workflows/deploy.yaml`）：

1. 推送 `worker.js`、`twitter.css`、`wrangler.toml` 或 `deploy.yaml` 的变更时自动触发
2. 从 CDN 下载并压缩 water.css
3. 通过 `cloudflare/wrangler-action@v4` 部署

需要在 GitHub 仓库 Secrets 中设置 `CLOUDFLARE_API_TOKEN`。

## 技术栈

- **运行时：** Cloudflare Workers
- **语言：** 纯 JavaScript（ES Module），无构建步骤，零依赖
- **上游 API：** [FxEmbed](https://github.com/FxEmbed/FxEmbed)（获取推文数据）
- **基础样式：** [water.css](https://github.com/kognise/water.css)（在 CI 中下载并内联）
- **自定义样式：** `twitter.css`（覆盖 water.css 的推文布局样式）

## 文件结构

```txt
.
├── .github/workflows/deploy.yaml  # CI/CD 流水线
├── worker.js                      # Worker 主程序（全部逻辑）
├── wrangler.toml                  # Cloudflare Workers 配置
├── twitter.css                    # 推文展示样式（覆盖 water.css）
├── water.css                      # (CI 生成) 基础样式
└── LICENSE                        # MIT
```

## License

[MIT](LICENSE)
