---
okf_version: "0.2"
---

# 文件

- [外置资产与构建部署](assets-and-build.md) - 自包含渲染的外置 /assets/ 资产策略（immutable 长缓存）、build.sh 构建脚本与 CI 部署流水线
- [Telegram 机器人](bot.md) - 介绍 Telegram 转换机器人的 webhook 安全模型与链接转换工作流
- [HTML 与微信文章代理](html-wechat.md) - 梳理 HTML 抓取改写代理与微信公众号文章代理的实现与差异
- [Markdown 转换](markdown.md) - 解释三条路由的 Markdown 变体生成、约束与缓存机制
- [媒体代理与 GitHub 渲染](media-github.md) - 介绍媒体代理与 GitHub 文件渲染子系统的实现细节
- [快速上手](quickstart.md) - 为新读者提供 x-page 的概览、服务目录与本地开发部署入口
- [路由与请求处理](routing.md) - 说明统一 Worker 如何分发请求到各子路由，强调路由优先级、外置 /assets/ 分支与兜底逻辑
- [存储与 AI 绑定](storage-and-ai.md) - 梳理持久化层 R2 缓存策略与 Workers AI 绑定，以及环境变量配置
- [推文服务](tweet.md) - 阐明推文渲染的数据源、翻译与缓存策略，以及自推线程补全逻辑
