/**
 * worker.js —— 应用入口（Router）
 * ============================================================
 *
 * 整个 Hostname 的所有路由都通过这一个 ES Module 的
 * `export default { fetch }` 暴露给 Cloudflare Workers 运行时。
 *
 * 本文件只做三件事：
 *   1. 导入资产（CSS / Artplayer JS）—— Wrangler Text module rule 要求
 *      导入在入口完成；/assets/ 路由直接 serve，浏览器走缓存
 *   2. 把请求路径做首次分类，委托给 routes/* 子模块的 handler
 *
 * 路由优先级（从高到低）：
 *   /               使用说明页
 *   /favicon.ico    静默返回 204
 *   /assets/        静态 CSS/JS（1 年 immutable 缓存，飞书多 iframe 只取一次）
 *   /webhook        Telegram bot 更新入口（POST，校验 secret_token）
 *   /vid/  /vid/d/  视频代理 / 直连
 *   /img/  /img/d/  图片代理 / 直连
 *   /html/          HTML 抓取 + 改写代理（自定义 UA、防盗链）
 *   /wechat/        微信公众号文章专用（标题可点回原文）
 *   /proxy/         通用媒体代理
 *   /github/        GitHub README 渲染（/assets/github.css）
 *   /<user>/status/<id>  推文（兜底 —— 因为形态最宽泛）
 *   其他            404
 *
 * 新增特性的范式：在 routes/ 下新建一个模块，导出 handle 函数，
 * 然后在此文件里加一条 if 转发即可。
 * ============================================================
 */

// 外置CSS/JS：通过 wrangler Text module rule 作为字符串导入，worker 直接 serve（/assets/ 路由）
// 浏览器通过 <link>/<script> 加载，可走 HTTP 缓存，飞书文档内 N 个 iframe 只下载一次。
// artplayer: CI 通过 JSON.stringify 把 artplayer.js 源码打包成 artplayer.mjs 的 export default 字符串
// highlight.mjs: Worker 侧 SSR 渲染用，不下发浏览器。
import ARTPLAYER_JS from "./artplayer.mjs";
import TWITTER_CSS from "./assets/twitter.css";
import GITHUB_CSS from "./assets/github.css";

// GitHub 代码高亮（Worker 端渲染，浏览器零 JS）。
// highlight.mjs：highlight.js core + 15 种核心语言模块打包成的 ES Module，
// 暴露 highlightCode / highlightWith / BUILTIN_LANGS / HLJS_THEME_CSS。
// Worker 端用 hljs.highlight() 纯函数直接产出着色好的静态 HTML，浏览器不跑任何 JS。
import * as HLJS from "./highlight.mjs";

// 各子路由 handler
import { indexHtml } from "./routes/index.js";
import { handleProxy } from "./routes/proxy.js";
import { serveVideo } from "./routes/video.js";
import { serveImage } from "./routes/image.js";
import { serveHtml, serveR2Html } from "./routes/html.js";
import { serveWechat } from "./routes/wechat.js";
import { serveGithub } from "./routes/github.js";
import { serveTweet } from "./routes/tweet.js";
import { handleWebhook } from "./routes/webhook.js";

/**
 * Cloudflare Workers 运行时的主入口。
 *
 * 注意 cleanPath 的处理顺序：
 *   1. strip 首斜杠
 *   2. 做一次 decodeURIComponent，让中文 / 部分特殊字符路径也能被识别
 *   3. decode 失败时的路径可能本身是 encoded 形态，留给下游自己再 decode 一次
 *
 * @param {Request} request 入站请求
 * @param {Object} env 绑定的环境变量（vars + secrets）
 * @returns {Response}
 */
export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    let cleanPath = u.pathname.replace(/^\//, "");
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch (e) {
      /* keep raw — 下游自行再 decode */
    }

    // 根路径 → 使用说明页
    if (!cleanPath) {
      return indexHtml(u.host);
    }

    // favicon 静默吞掉，避免噪音
    if (cleanPath === "favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Telegram bot webhook（POST /webhook，与其余服务共用本 hostname）
    if (cleanPath === "webhook") {
      return handleWebhook(request, env, ctx);
    }

    // 视频路由
    if (cleanPath === "vid" || cleanPath.startsWith("vid/")) {
      return serveVideo(request, cleanPath, u.host);
    }

    // 图片路由
    if (cleanPath === "img" || cleanPath.startsWith("img/")) {
      return serveImage(request, cleanPath, u.host);
    }

    // HTML 抓取 + 改写代理（微信公众号文章阅读等）
    // 传 ctx：Accept: text/markdown 时需要它把转换结果后台写回 R2
    if (cleanPath === "html" || cleanPath.startsWith("html/")) {
      return serveHtml(request, env, ctx);
    }

    // HTML 抓取 + 改写代理 + R2 持久缓存（HTML 视图先查 R2，miss 才抓取并写回）
    if (cleanPath === "r2-html" || cleanPath.startsWith("r2-html/")) {
      return serveR2Html(request, env, ctx);
    }

    // 微信公众号文章专用代理（标题可点回原文）
    if (cleanPath === "wechat" || cleanPath.startsWith("wechat/")) {
      return serveWechat(request, env, ctx);
    }

    // 通用媒体代理
    if (cleanPath === "proxy" || cleanPath.startsWith("proxy/")) {
      return handleProxy(request);
    }

    // 静态资产：CSS/JS 外置，带 1 年 immutable 缓存，飞书多 iframe 只取一次
    if (cleanPath.startsWith("assets/")) {
      const assetName = cleanPath.slice("assets/".length);
      const assets = {
        "twitter.css": { body: TWITTER_CSS, type: "text/css; charset=utf-8" },
        "github.css": { body: GITHUB_CSS, type: "text/css; charset=utf-8" },
        "artplayer.js": { body: ARTPLAYER_JS, type: "text/javascript; charset=utf-8" },
      };
      const asset = assets[assetName];
      if (!asset) return new Response("not found", { status: 404 });
      return new Response(asset.body, {
        headers: {
          "content-type": asset.type,
          "cache-control": "public, max-age=31556952, immutable",
        },
      });
    }

    // GitHub README 自述页渲染（固定前缀 /github/，不会与推文兜底冲突）
    if (cleanPath === "github" || cleanPath.startsWith("github/")) {
      return serveGithub(request, env, cleanPath, u.pathname, HLJS);
    }

    // 推文路由（兜底 — 因为 /<user>/status/<id> 形态最宽泛，需最后匹配）
    return serveTweet(request, env, cleanPath, ctx);
  },
};
