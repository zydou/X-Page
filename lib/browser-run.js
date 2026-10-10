/**
 * lib/browser-run.js
 * ============================================================
 * HTML → Markdown 转换层（基于 Browser Run /markdown quick action）。
 *
 * 注意与 lib/markdown.js 的区别：那个是 markdown → HTML（给 /github/
 * 渲染 README 用），本模块是反方向，且依赖 Browser Run 绑定。
 *
 * 为什么用 html= 而不是 url=：
 *   /html/ 与 /wechat/ 依赖自定义 User-Agent（默认 iOS 微信内置浏览器）+
 *   Referer 才能拿到正文；而 Browser Run 的浏览器请求被 Cloudflare 恒定为
 *   bot 流量、Referer 也无法伪造，用 url= 直接抓不到微信公众号文章。
 *   所以由 Worker 自己抓 HTML，再把完整字符串喂给转换服务。
 *
 * 免费套餐约束（决定本模块必须被 R2 缓存包住）：
 *   Quick Actions 每 10 秒 1 次、浏览器时间 10 分钟/天。
 *   因此每次转换的结果都必须落 R2，让每个 URL 一生只付一次配额。
 * ============================================================
 */

import { estimateTokens } from "./utils.js";

/**
 * 调 Browser Run 把 HTML 字符串转成 Markdown 字符串。
 *
 * quickAction() 的绑定类型是 Fetcher，因此返回 Promise<Response>；
 * 响应体为 { success, meta, result }，result 即 Markdown 文本。
 * 转换服务会自带 YAML frontmatter（取自页面 <title>），此处原样保留。
 *
 * @param {Object} browser env.BROWSER 绑定
 * @param {string} html 待转换的完整 HTML
 * @returns {Promise<string>} Markdown 文本
 * @throws {Error&{status?: number, retryAfter?: string}} 绑定缺失 / 配额耗尽 /
 *   转换失败 / 返回空结果。status 为转换服务的 HTTP 状态（429 等），
 *   retryAfter 为其建议的退避秒数。
 */
export async function convertHtml(browser, html) {
  if (!browser) throw new Error("BROWSER binding missing");

  const resp = await browser.quickAction("markdown", { html });
  const body = await resp.json().catch(() => ({}));

  if (!resp.ok || !body || body.success !== true) {
    const err = new Error((body && body.errors && body.errors[0] && body.errors[0].message) || "browser-run " + resp.status);
    err.status = resp.status;
    err.retryAfter = resp.headers.get("retry-after");
    throw err;
  }
  if (typeof body.result !== "string" || !body.result.trim()) {
    throw new Error("browser-run returned empty markdown");
  }
  return body.result;
}

/**
 * 把 HTML 里的内部路径（/proxy/、/html/）补成本 Worker 的绝对 URL。
 *
 * 转换服务的 html= 模式不解析相对 URL（实测：href="/docs" 原样输出为 (/docs)，
 * srcset 属性甚至被整个丢弃），而 Markdown 消费方没有 base URL 可解析。
 * 喂进去之前必须补全，否则产出的是全篇死链。
 *
 * 只匹配紧跟在引号之后的内部路径：buildRewriter 经 setAttribute 写入的值一律
 * 带双引号，<style> 里的 url() 由 rewriteCssUrls 写成 url("...") 也带引号。
 * 这样不会误伤 https://foo.com/proxy/bar 这类外部同路径 URL。
 *
 * @param {string} html 已完成资源改写的 HTML
 * @param {string} origin 本 Worker 的 https origin，例如 "https://x.example.dev"
 * @returns {string}
 */
export function absolutizeInternal(html, origin) {
  return html.replace(/(?<=["'])\/(proxy|html)\//g, origin + "/$1/");
}

/**
 * 组装 Markdown 响应。
 *
 * 必须带 Vary: Accept——同一个 URL 现在有 HTML / Markdown 两种表示，
 * 边缘不区分的话会把 HTML 直接喂给要 Markdown 的客户端。
 * 缓存一年：R2 已是唯一内容来源且永不过期，长 TTL 只让边缘少读几次 R2。
 *
 * @param {string} md Markdown 正文
 * @param {string} cacheState "hit" | "miss"
 * @returns {Response}
 */
export function markdownResponse(md, cacheState) {
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=31556952",
      "vary": "Accept",
      "access-control-allow-origin": "*",
      "x-cache": cacheState,
      "x-markdown-tokens": String(estimateTokens(md)),
    },
  });
}
