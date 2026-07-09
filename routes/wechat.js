/**
 * routes/wechat.js
 * ============================================================
 * 微信公众号文章专用代理：/wechat/<encodeURIComponent(url)>
 *
 * 与 /html/ 共享抓取 + 资源代理逻辑，唯一差异是给文章标题包上
 * <a href="原文链接">，方便用户在嵌入环境里点标题跳转。
 *
 * 复用方式：通过 serveHtml 的 transform 钩子注入 wrapTitleLink。
 *
 * 标题 DOM 特征：<h1 class="rich_media_title" id="activity-name">
 * 非微信公众号页面不会命中，退化为与 /html/ 相同行为，不报错。
 * ============================================================
 */

import { serveHtml } from "./html.js";

/**
 * 把文章标题（h1#activity-name）的正文包上 <a href="原文链接">。
 *
 * @param {string} html 已改写资源路径后的完整 HTML
 * @param {string} target 文章原始 URL，用作 <a> 的 href
 * @returns {string}
 */
function wrapTitleLink(html, target) {
  return html.replace(
    /(<h1\b[^>]*\bid="activity-name"[^>]*>)([\s\S]*?)<\/h1>/i,
    (_match, openTag, inner) =>
      `${openTag}<a href="${target}" target="_blank">${inner.trim()}</a></h1>`
  );
}

/**
 * 处理 /wechat/<encoded> 请求。
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Response}
 */
export async function serveWechat(request, env) {
  return serveHtml(request, env, wrapTitleLink, "/wechat/");
}
