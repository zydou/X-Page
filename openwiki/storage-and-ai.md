---
type: 系统
title: 存储与 AI 绑定
description: 梳理持久化层 R2 缓存策略与 Workers AI 绑定，以及环境变量配置
tags: [R2, 存储, Workers AI, 配置]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-06T03:00:20.989Z
sources:
  - id: openwiki-source-529e9dc3a2b5d10c27b03b93
    resource: repo://lib/to-markdown.js
  - id: openwiki-source-8f4419482b64e334cd5f4bb6
    resource: repo://wrangler.toml
generated: { by: "claude-code", at: "2026-11-06T03:00:20.989Z" }
---

# 存储与 AI 绑定

x-page 的几乎所有持久化都过 R2 桶 `x-page`（绑定 `TWEETS`）。AI 绑定只在一条链路上使用。

## 1 绑定总表

`wrangler.toml` 的绑定与变量（`wrangler.toml:20-75`）：

| Name | 类型 | 说明 |
|---|---|---|
| `TWEETS` | R2 bucket `x-page`（dev 是 `x-page-dev`） | 推文 JSON、`wechat/` HTML、`md/` Markdown 三个前缀共用同一桶 |
| `AI` | Workers AI | `/html/` 与 `/wechat/` 的 `Accept: text/markdown` 转换用 |

## 2 R2 键前缀与 lifecycle

| 前缀 | 存什么 | 生命周期 |
|---|---|---|
| `tweet/<id>.json` | 未翻译的 fxtwitter thread JSON | 365 天过期（`expire-tweets-after-1y` lifecycle） |
| `tweet/<id>.<lang>.json` | 带翻译的 thread JSON（`?lang=` 或 `TWITTER_LANG`） | 同上，按语言一份 |
| `wechat/<原文URL>` | 渲染好的完整 HTML | **永久保留**（防失效优先，无过期规则） |
| `md/<route>/<target>` | `/html/` 与 `/wechat/` 的 Markdown 变体 | **永久保留**，同一 URL 一生只转一次 |

`tweet/` 前缀 365 天后自动过期；`wechat/` 与 `md/` 无过期规则，永久保留。推文 R2 命中规则是「有对象就用、无应用层过期判断」，唯一回源触发是用户主动 `?refresh=1`。

## 3 Workers AI 绑定：toMarkdown 零消耗

`/html/` 与 `/wechat/` 的 Markdown 变体走 `env.AI.toMarkdown()`（`lib/to-markdown.js`）。它的 HTML 转换是纯确定性解析（剥离 script/style、抽 meta、解析相对链接），**不调用任何模型**，消耗 0 Neuron，完全不碰免费套餐 10,000 Neurons/天 池子（2026-10 在本账号验证；见 [Markdown 转换](markdown.md)）。

AI 绑定的使用仅限一条路径；Markdown 转换结果必须先落 R2、命中才返回，因为转换本身 130–330ms、约 8% 请求有 48–100 秒长尾（`lib/to-markdown.js:25-27`），不缓存代价太高。

> [!NOTE]
> `toMarkdown` 输入上限约 4 MiB（字符上限 `3_900_000`），超出提前拦截返回 502，不让服务端在长尾里挂 41 秒才回 6006。

## 4 Vars 与 Secrets

`wrangler.toml [vars]`（生产）：

| Var | 用途 |
|---|---|
| `TIMEZONE = "Asia/Shanghai"` | 推文时间戳显示时区 |
| `TWITTER_LANG = "cn"` | 推文翻译目标语言，`?lang=` 覆盖 |
| `TWITTER_PREWARM_LANGS = "cn,ja"` | Telegram bot 推文预热语言列表（逗号分隔 BCP-47），每种语言各写一份 `tweet/<id>.<lang>.json`。为空则回退 `TWITTER_LANG`。仅影响 bot 预热，`serveTweet` 默认渲染仍用 `TWITTER_LANG` |
| `UA` | `/html/` 抓取的 User-Agent，默认 iOS 微信 UA |
| `GITHUB_TOKEN` | Worker Secret（`wrangler secret put`），`/github/` 的 GitHub API 限流提升（60/h → 5000/h） |

Telegram Bot 秘密（`wrangler secret put`，`/webhook` 运行时读取）：

| Secret | 用途 |
|---|---|
| `BOT_TOKEN` | Telegram Bot API 根路径，`apiBase()` / `fileUrl()` 内嵌 |
| `WEBHOOK_SECRET` | webhook 入口 fail-closed 校验头 |
| `IMGUR_CLIENTID` | 媒体上传 Imgur 认证 |
| `IMGBB_API_KEY` | 图片回退上传 ImgBB 认证 |
| `X_PAGE_BASE` | 生成链接的根地址；无兜底，缺失即拒绝转换 |
| `ALLOWED_CHATS` | 白名单 chat / thread 组合 |

Telegram 秘密的完整使用说明见 [Telegram 机器人](bot.md)。

## 5 关联

- Markdown 转换的缓存与 R2 key 隔离 → [Markdown 转换](markdown.md)
- /wechat/ 的 R2 缓存与防失效语义 → [HTML 与微信文章代理](html-wechat.md)
- 推文 R2 键的语言维度 → [推文服务](tweet.md)
