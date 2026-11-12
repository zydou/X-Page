---
type: 入门
title: 快速上手
description: 为新读者提供 x-page 的概览、服务目录与本地开发部署入口
tags: [快速上手, 概览, 开发, 部署]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-12T05:54:32.565Z
sources:
  - id: openwiki-source-8a2e26d4137b8250f68bb869
    resource: repo://build.sh
  - id: openwiki-source-8671e0889cf4d1fe8869457d
    resource: repo://routes/index.js
  - id: openwiki-source-1adf5eb6c74462684e873d78
    resource: repo://worker.js
  - id: openwiki-source-8f4419482b64e334cd5f4bb6
    resource: repo://wrangler.toml
generated: { by: "claude-code", at: "2026-11-12T05:54:32.565Z" }
---

# 快速上手

`x-page` 是运行在 Cloudflare Worker 上的多服务代理：一个 hostname 背后提供推文渲染、视频 / 图片代理、HTML 与微信公众号代理、GitHub README 渲染、Telegram 转换机器人。渲染页面的浏览器 CSS / JS
**外置**到 `/assets/<name>`（immutable 长缓存，飞书多 iframe 共享一份浏览器缓存），Worker 仍通过 Text module 导入这些字符串、不引用外部 origin。

## 1 定位与范围

把 <https://x.com> / Twitter、GitHub、微信公众号、任意图片/视频/网页 URL 转成自包含 HTML（或 Markdown），供嵌入环境（飞书、Notion、Telegram）直接呈现。服务本身是“无状态 Worker + R2
缓存”，没有自己的数据库；仅当对外公开 X 后，后续访问自动命中缓存。

## 2 服务目录

| 路径                                        | 服务                                                                             | 详细 |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ---- |
| `GET /`                                     | 302 跳转到项目 GitHub 主页                                                       | [路由](routing.md) |
| `GET /<user>/status/<id>[?mode=m][&lang=l]` | 推文 → 自包含 HTML / Markdown；`mode=self`、`quote`、`thread`、`all`（缺省 all） | [推文](tweet.md) |
| `GET /vid/<url>` 与 `/vid/d/<url>`          | 视频播放器 HTML（代理 / 直连）                                                   | [媒体代理与 GitHub 渲染](media-github.md) |
| `GET /img/<url>` 与 `/img/d/<url>`          | 自适应图片预览 HTML                                                              | 同上 |
| `GET /html/<url>`                           | HTML 抓取 + 改写代理                                                             | [HTML 与微信文章代理](html-wechat.md) |
| `GET /r2-html/<url>`                        | 同 `/html/`，HTML 视图额外缓存 R2（`html/`，原文失效后仍可读）                   | 同上、[存储与 AI 绑定](storage-and-ai.md) |
| `GET /wechat/<url>`                         | 微信公众号文章代理（标题回跳原文）                                               | 同上 |
| `GET /proxy/<url>`                          | 通用媒体代理                                                                     | 同上 |
| `GET /assets/<name>`                        | 外置静态 CSS/JS（immutable 长缓存）                                              | [外置资产与构建部署](assets-and-build.md) |
| `GET /github/<user>/<repo>[/<path>]`        | GitHub README / 代码文件渲染（目录列表）                                         | 同上、[Markdown 转换](markdown.md) |
| `POST /webhook`                             | Telegram bot 转换入口                                                            | [Telegram 机器人](bot.md) |

URL 直接拼在前缀后面即可——浏览器自动编码（只有含 `?`、`#`、空格、非 ASCII 时才需要 `encodeURIComponent`，可到 [meyerweb dencoder](https://meyerweb.com/eric/tools/dencoder/) 转换）。

## 3 本地开发

```bash
# 下载并构建远端资产（CSS / JS / markdown-it / highlight.js 全部在本机补齐）
sh build.sh

# 启动本地 dev server（热重载）
npx wrangler dev
```

本地改完路由后直接 curl：

```bash
curl http://localhost:8787/<user>/status/<id>
curl http://localhost:8787/html/<url>
curl -H "Range: bytes=0-100" http://localhost:8787/proxy/<url>   # range 透传验证
curl -H "Accept: text/markdown" http://localhost:8787/html/<url>
```

## 4 部署

两阶段决策：**先 debug 后 production**。

```bash
# 1) Debug：新起 x-dev Worker，验证每条路由
cp wrangler.toml wrangler.dev.toml   # 改 name = "x-dev" 与 dev hostname
npx wrangler deploy --config wrangler.dev.toml

# 2) Production：dev 通过后再发
npx wrangler deploy
```

生产验证：

```bash
curl https://<host>/html/https%3A%2F%2Fexample.com/
curl https://<host>/wechat/https%3A%2F%2Fmp.weixin.qq.com%2Fs%2F...
curl -H "Range: bytes=0-..." https://<host>/proxy/<url>
```

> [!WARNING]
> **不要等 CI 绿灯**：`.github/workflows/deploy.yaml` 的 Deploy job 经常排队数分钟，正确的验证方式是 Wrangler 直接部署并在边缘 curl 验证。CI 只做兜底 + push 时自动发布生产 Worker。

### CI 触发路径

push 到 `worker.js`、`routes/**`、`lib/**`、`assets/**`、`wrangler.toml`、`build.sh`、`deploy.yaml` 都会触发 Deploy workflow，或手动 `workflow_dispatch`。

## 5 绑定与变量

| 项                                            | 用途 |
| --------------------------------------------- | ---- |
| R2 `TWEETS`（桶 `x-page` / dev `x-page-dev`） | `tweet/`、`wechat/`、`html/`、`md/` 前缀共用（`md/` 下为 `md/html/` 与 `md/wechat/`）；`tweet/` 365 天 lifecycle 过期 |
| Workers AI `env.AI`                           | `/html/`、`/r2-html/` 与 `/wechat/` 的 Markdown 转换，0 Neuron |
| `TIMEZONE = "Asia/Shanghai"`                  | 推文时间戳显示时区 |
| `TWITTER_LANG = "cn"`                         | 推文默认翻译语言；`?lang=` 覆盖 |
| `TWITTER_PREWARM_LANGS = "cn,ja"`             | Telegram bot 推文预热语言列表（逗号分隔），每条链接各写一份 `tweet/<id>.<lang>.json`；为空回退 `TWITTER_LANG` |
| `UA`                                          | `/html/` 抓取默认 iOS 微信 UA，可覆盖 |
| `GITHUB_TOKEN`（Secret）                      | `/github/` 的 GitHub API 限流提升 |

Telegram bot 秘密（`BOT_TOKEN`、`WEBHOOK_SECRET`、`IMGUR_CLIENTID`、`IMGBB_API_KEY`、`X_PAGE_BASE`、`ALLOWED_CHATS`）走 `wrangler secret put`。完整表格见 [存储与 AI 绑定](storage-and-ai.md)。

## 6 关联

- 所有请求如何分发 → [路由与请求处理](routing.md)
- 内置资产与构建过程 → [外置资产与构建部署](assets-and-build.md)
- GitHub 的 Markdown 渲染管线 → [Markdown 转换](markdown.md)
