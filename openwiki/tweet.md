---
type: 子系统
title: 推文服务
description: 阐明推文渲染的数据源、翻译与缓存策略，以及自推线程补全逻辑
tags: [推文, Twitter, fxtwitter, 翻译, R2缓存]
verified:
  - by: openwiki/0.9.0
    at: 2026-11-05T11:10:10.273Z
sources:
  - id: openwiki-source-51d8dc0d173d42237cb85fda
    resource: repo://lib/thread.js
  - id: openwiki-source-7e7c48b6dbe712bdc9057f3a
    resource: repo://routes/tweet.js
generated: { by: "claude-code", at: "2026-11-05T11:10:10.273Z" }
---

# 推文服务

`/<user>/status/<id>[?mode=m][&lang=l]` 是 x-page 的主力路由：把 X / Twitter 推文渲染成完全自包含的 HTML（内联 water.css + twitter.css），供嵌入环境直接呈现。

数据来源是 **fxtwitter**（非官方镜像，对 X API 的 Thread 数据做了友好封装）。翻译挂在 fxtwitter 端，x-page 只负责渲染、缓存与自推链补全。

## 1 数据流与缓存

请求管线（`routes/tweet.js:630-698`）：

1. `extractPid()` 从路径提取 ID；不匹配直接 404。
2. `parseMode()` 决定 `mode`（缺省即 `all`；非法值回退 `all`）。
3. `fetchTweetData()` 调 fxtwitter `/2/thread/<id>[?lang=<lang>]`，返回 `{ status, thread[] }`。译文通过 fxtwitter 的 `translation` 字段给。

### 1.1 `mode` 四种取值

| 值 | 含义 |
|---|---|
| `all`（缺省） | 完整 thread（含本推祖先）+ 每条引用 |
| `self` | 仅本推 |
| `quote` | 本推 + 引用 |
| `thread` | 本推 + 串推后代（剔除祖先） |

串推后代用 `descendantsOf()` 从 thread 中按作者与 `replying_to` 计算（`lib/thread.js`）。

### 1.2 翻译：`TRANSLATE_TO` 与 `?lang=`

- 查询 `?lang=` 优先于 `TRANSLATE_TO` 环境变量；两者都缺省则不翻译，fxtwitter 返回原文（`routes/tweet.js:635`）。
- **R2 key 带语言维度**：`tweet/<id>.<lang>.json`（无翻译时 `tweet/<id>.json`）。不同语言各存一份——`?lang=ja` 不会命中 `?lang=zh-cn` 缓存（`routes/tweet.js:708-711`）。
- lang 原样透传给 fxtwitter（`/2/thread/<id>?lang=<lang>`），译文由 `translation` 字段返回。

### 1.3 R2 缓存

- R2 键 `tweet/<id>[.<lang>].json`，有对象就直接用，**无应用层过期判断**。
- 唯一会回源的触发：用户主动点页面刷新按钮（`?refresh=1`）。
- R2 兜底清理：365 天 lifecycle 过期删除（见 [存储与 AI 绑定](storage-and-ai.md)）。
- HTML 响应头 `cache-control: no-store`，R2 是唯一真相源（边缘 purge 不可用原因见 [Markdown 转换](markdown.md)）。

### 1.4 Markdown 变体

`Accept: text/markdown` 时走 `renderMarkdown(data, cfg, mode, ...)` 把结构化数据渲染成 Markdown，响应头与 `/html/` 共享 `x-markdown-tokens` 估算，共 `vary: Accept`。完整说明见 [Markdown 转换](markdown.md)。

## 2 自推链补全：`lib/thread.js`

X/Twitter 的自推串推常被删单条推文截断——fxtwitter 的 `/2/thread` 向下遍历在被删推处截断，但向上遍历可穿过墓碑。`lib/thread.js` 是一组**纯函数**（不做 I/O，补全所需的会话数据经注入的 `io` 获取，可离线验证）：

### 2.1 墓碑判定 `isTombstone(post)`

墓碑是被删 / 被封 / 私密等不可用推文的占位对象（无正文、无时间）。判定规则（`lib/thread.js:27-31`）：空或无 id、`type === "tombstone"`、或无 author 且无 text 且无 html_no_media。墓碑在补全时是链上的节点、渲染时不输出。

### 2.2 补全门控 `needsSelfThreadRepair(thread)`

只对「自推链」触发补全：thread 中出现墓碑，**或**存在同作者的回复链接。单推、他人回复他人都不满足，因此零额外请求（`lib/thread.js:41-49`）。

### 2.3 根推 `findRoot(thread)`

thread 中没有父节点的活推文，取最早的一条（按 `created_timestamp`）。

### 2.4 按 `replying_to` 闭包补入

算法（`lib/thread.js:110-125`）：

1. 若 thread 中根被截断：取一条活节点的会话祖先链，确认是同作者自推链后并入、定位根。
2. 以根为起点，从会话回复里收集同作者回复，闭包并入（父节点已在链上才加入）。
3. 某回复的父节点既非已知活推文、也未尝试过 → 视为被删推，经 `parentOfTombstone()` 从会话祖先链推出墓碑的父节点（只处理链上恰一墓碑、多墓碑或不唯一时不猜测，直接返回 `null`），补回的墓碑带上 `replying_to` 让向下遍历能穿过。

### 2.5 HTML/Markdown 的自推链

`renderHtml()` / `renderMarkdown()` 渲染时走补全后的 thread，看不见墓碑、但保留被删推处的断链语义（被补上父链的墓碑本身不渲染）。

### 2.6 `?refresh_button=0`

页面上的「强制刷新」按钮通过 `?refresh_button=0` 隐藏（`routes/tweet.js:637`）；生成刷新 URL 时保留 `mode` 与 `lang`，避免点刷新后跳回默认（`routes/tweet.js:639-641`）。

## 3 关联

- Markdown 变体的整体规则与 R2 key → [Markdown 转换](markdown.md)
- R2 生命周期 → [存储与 AI 绑定](storage-and-ai.md)
- 路由如何命中的其他子服务 → [路由与请求处理](routing.md)
