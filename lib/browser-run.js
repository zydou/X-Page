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
 *
 * 429 在 Worker 内退避重试（见 convertHtml），客户端一次请求即得结果。
 * ============================================================
 */

import { estimateTokens } from "./utils.js";

// 免费套餐 Quick Actions 硬性速率限制 1 次/10 秒。这里在 Worker 内退避重试，
// 而不是把 429 甩回客户端。
//
// 墙钟时间不是障碍：HTTP 请求在免费套餐下无时长上限，且等待（setTimeout）
// 不消耗 CPU 时间——只有实际执行代码才计。所以等 10 秒重试的 CPU 成本近零。
//
// 但必须设上限。两个真实的墙：
//   1. Cloudflare 每周更新几次 runtime，在飞请求只给 30 秒宽限期，超时直接终止
//   2. 客户端自己有超时（典型 30-60 秒），等它超时不如尽早返回
// 25 秒 ≈ 2 次重试，能吸收约 3 个并发的首次转换请求。
const MAX_WAIT_MS = 25000;
// Retry-After 远超速率窗口说明是日浏览器预算（10 分钟/天）耗尽，不是速率限制——
// 等几个小时没有意义，直接抛回让上层返回 429。
const MAX_RETRY_AFTER_S = 60;

/**
 * 单次转换调用。429 由外层 convertHtml 负责退避重试。
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
async function convertOnce(browser, html) {
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
 * 把 HTML 转成 Markdown，遇 429 在 Worker 内退避重试。
 *
 * 非 429 错误立即抛出，不做任何重试。
 * 退避预算耗尽后抛出原始 429，由调用方按老逻辑返回 429 + Retry-After。
 *
 * @param {Object} browser env.BROWSER 绑定
 * @param {string} html 待转换的完整 HTML
 * @returns {Promise<string>} Markdown 文本
 */
export async function convertHtml(browser, html) {
  if (!browser) throw new Error("BROWSER binding missing");

  const start = Date.now();
  for (;;) {
    try {
      return await convertOnce(browser, html);
    } catch (e) {
      if (!e || e.status !== 429) throw e;

      const raS = Number(e.retryAfter) || 10;
      if (raS > MAX_RETRY_AFTER_S) throw e;

      // 抖动：并发的多个请求若都睡整整 N 秒，会在同一刻重试、又一起撞 429，
      // 形成同步羊群。加 0-2 秒让它们自然错开。
      const wait = Math.min(raS * 1000 + Math.random() * 2000, MAX_WAIT_MS - (Date.now() - start));
      if (wait <= 0) throw e;

      await new Promise((r) => setTimeout(r, wait));
    }
  }
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
