/**
 * worker.js —— 应用入口（Router）
 * ============================================================
 *
 * 整个 Hostname 的所有路由都通过这一个 ES Module 的
 * `export default { fetch }` 暴露给 Cloudflare Workers 运行时。
 *
 * 本文件只做三件事：
 *   1. 导入内联资产（CSS / Artplayer JS）—— Wrangler Text module rule 要求
 *      这些 import 必须在入口文件完成，子模块无法再以 ESM 方式导入它们。
 *   2. 把请求路径做首次分类，委托给 routes/* 子模块的 handler。
 *   3. 把资产字符串作为参数传给需要它的下游（video / tweet）。
 *
 * 路由优先级（从高到低）：
 *   /               使用说明页
 *   /favicon.ico    静默返回 204
 *   /vid/  /vid/d/  视频代理 / 直连
 *   /img/  /img/d/  图片代理 / 直连
 *   /html/          HTML 抓取 + 改写代理（自定义 UA、防盗链）
 *   /proxy/         通用媒体代理
 *   /<user>/status/<id>  推文（兜底 —— 因为形态最宽泛）
 *   其他            404
 *
 * 新增特性的范式：在 routes/ 下新建一个模块，导出 handle 函数，
 * 然后在此文件里加一条 if 转发即可。
 * ============================================================
 */

// 内联CSS：通过 wrangler Text module rule 作为字符串导入（见 wrangler.toml 的 rules）。
// 内联JS：CI 通过 JSON.stringify 把 artplayer.js 源码打包成 artplayer.mjs 的 export default 字符串，
// Wrangler 以 ESM 形式导入后通过参数注入到 HTML 模板，彻底避免与 Worker 模板字面量冲突。
import ARTPLAYER_JS from "./artplayer.mjs";
import WATER_CSS from "./water.css";
import TWITTER_CSS from "./twitter.css";

// 各子路由 handler
import { indexHtml } from "./routes/index.js";
import { handleProxy } from "./routes/proxy.js";
import { serveVideo } from "./routes/video.js";
import { serveImage } from "./routes/image.js";
import { serveHtml } from "./routes/html.js";
import { serveTweet } from "./routes/tweet.js";

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
  async fetch(request, env) {
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

    // 视频路由
    if (cleanPath === "vid" || cleanPath.startsWith("vid/")) {
      return serveVideo(request, cleanPath, u.host, ARTPLAYER_JS);
    }

    // 图片路由
    if (cleanPath === "img" || cleanPath.startsWith("img/")) {
      return serveImage(request, cleanPath, u.host);
    }

    // HTML 抓取 + 改写代理（微信公众号文章阅读等）
    if (cleanPath === "html" || cleanPath.startsWith("html/")) {
      return serveHtml(request, env);
    }

    // 通用媒体代理
    if (cleanPath === "proxy" || cleanPath.startsWith("proxy/")) {
      return handleProxy(request);
    }

    // 推文路由（兜底 — 因为 /<user>/status/<id> 形态最宽泛，需最后匹配）
    return serveTweet(request, env, cleanPath, WATER_CSS, TWITTER_CSS);
  },
};
