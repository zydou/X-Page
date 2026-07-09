/**
 * routes/html.js
 * ============================================================
 * HTML 抓取 + 资源代理：/html/<encodeURIComponent(url)>
 *
 * 解决微信公众号文章被第三方平台（如飞书）服务器 IP 拒绝的问题：
 * 让 Worker 作为中立客户端去抓原文，再喂给嵌入环境。
 *
 * 与 /proxy/ 的关键差异：
 *   - 可覆盖上游 User-Agent：微信公众号对 UA 白名单限制，
 *     通过 wrangler.toml [vars] UA 变量注入真实浏览器 UA
 *   - HTML 改写：把所有需要远程加载的资源 URL 重写成内部
 *     /proxy/<encoded>，让浏览器发出的每个资源请求都走 Worker。
 *     好处：
 *       1. Worker 作为客户端发请求时不带 Referrer，自然绕过
 *          微信图片防盗链
 *       2. Cloudflare 边缘加速，境外图片在国内也能快速访问
 *   - 改写范围（由标签决定）：
 *       <img src/srcset>  <script src>  <link href>
 *       <video src/poster>  <audio src>  <source src/srcset>
 *       <embed src>  <object data>  <iframe src>  <track src>
 *       以及 <style> 块 / 内联 style 属性中的 url(...)
 *
 * 被谁调用：
 *   - 入口匹配 /html/ 前缀
 *
 * 路径约定：
 *   Worker 收到的 pathname = "/html/<encoded>"
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";

// 微信公众号白名单 UA：iOS 微信内置浏览器。
// 用户可通过 wrangler.toml [vars] UA 覆盖。
const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";

/**
 * 标签 → 其取值当作远程资源 URL 的属性名。
 */
const TAG_RESOURCE_ATTRS = {
  img: ["src", "srcset"],
  script: ["src"],
  link: ["href"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "srcset"],
  embed: ["src"],
  object: ["data"],
  iframe: ["src"],
  track: ["src"],
};

/**
 * 该 URL 是否需要改写。
 *
 * @param {string|undefined} url
 * @returns {boolean}
 */
function shouldProxy(url) {
  if (!url) return false;
  const t = url.trim();
  if (!t) return false;
  // data/blob 内联内容无需代理；# 锚点 / javascript: 不代理；
  // 已写入 /proxy/ 的内部路径避免重复包裹。
  if (/^(data:|blob:|javascript:|#)/i.test(t)) return false;
  if (t.startsWith("/proxy/")) return false;
  return true;
}

/**
 * 把可能为相对路径的 URL 解析为绝对 URL。
 * base 取被代理页的完整 URL，确保 /path 与 ../path 都能正确解析。
 *
 * @param {string} url
 * @param {string} base 被代理页的完整 URL
 * @returns {string}
 */
function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

/**
 * 改写单个 srcset 属性值（逗号分隔的 "url [descriptor]" 列表）。
 *
 * @param {string} value
 * @param {string} base
 * @returns {string}
 */
function rewriteSrcset(value, base) {
  return value
    .split(",")
    .map((entry) => {
      const parts = entry.trim().split(/\s+/);
      if (!parts.length) return entry;
      const url = parts[0];
      if (!shouldProxy(url)) return entry;
      parts[0] = proxyUrl(resolveUrl(url, base));
      return parts.join(" ");
    })
    .join(", ");
}

/**
 * 改写一段属性文本里指定名称的属性值。
 *
 * @param {string} attrsText 仅属性部分，例如 ` src="a.js" class="x"`
 * @param {string} attrName  属性名（小写），如 "src"
 * @param {string} base
 * @returns {string}
 */
function rewriteAttr(attrsText, attrName, base) {
  // 匹配 name = "value" / 'value' / 无引号值
  const re = new RegExp(`\\b${attrName}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi");
  return attrsText.replace(re, (m, _all, qd, qs, qn) => {
    const val = qd !== undefined ? qd : qs !== undefined ? qs : qn;
    if (!shouldProxy(val)) return m;
    let next;
    if (attrName === "srcset") {
      next = rewriteSrcset(val, base);
    } else {
      next = proxyUrl(resolveUrl(val, base));
    }
    return `${attrName}="${next}"`;
  });
}

/**
 * 改写属性文本中任意 url(...) 引用（CSS 背景图、字体等）。
 *
 * @param {string} text
 * @param {string} base
 * @returns {string}
 */
function rewriteCssUrls(text, base) {
  return text.replace(/url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi, (m, _q, url) => {
    if (!shouldProxy(url)) return m;
    return `url("${proxyUrl(resolveUrl(url, base))}")`;
  });
}

/**
 * 改写某个标签的远程资源属性（不含标签名本身）。
 *
 * @param {string} tagName 标签名
 * @param {string} attrsText
 * @param {string} base
 * @returns {string}
 */
function rewriteTagAttrs(tagName, attrsText, base) {
  const list = TAG_RESOURCE_ATTRS[tagName.toLowerCase()];
  let out = attrsText;
  if (list) {
    for (const a of list) out = rewriteAttr(out, a, base);
  }
  // 内联 style 属性也可能包含 url(...)，一并改写
  return rewriteCssUrls(out, base);
}

/**
 * 处理 /html/<encoded> 请求。
 *
 * @param {Request} request 入站请求
 * @param {Object} env wrangler 注入的环境变量（含 vars + secrets）
 * @returns {Response}
 */
export async function serveHtml(request, env) {
  const url = new URL(request.url);
  const encoded = url.pathname.slice("/html/".length);
  if (!encoded) return new Response("missing url", { status: 400 });

  let target;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response("bad encoding", { status: 400 });
  }
  if (!/^https?:\/\//i.test(target)) {
    return new Response("only http(s) urls are allowed", { status: 400 });
  }

  const ua = (env && env.UA) || DEFAULT_UA;

  const upstream = await fetch(target, {
    headers: {
      "user-agent": ua,
      // 微信文章页对 referer 也有校验，塞一个自家域名降低被拒概率
      referer: new URL(target).origin + "/",
    },
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, { status: upstream.status });
  }

  const contentType = upstream.headers.get("content-type") || "";

  // HTML：把远程资源全部改写成内部 /proxy/ 路径。
  if (contentType.includes("text/html")) {
    const html = await upstream.text();

    // 一次正则完成三类处理：
    //   1) <script ...>...</script> 块   → 改写 <script> 起始标签的 src，
    //      块内 JS 原样保留（避免破坏字面值字符串里的 "<img>" 等）
    //   2) <style ...>...</style> 块    → 改写 <style> 起始标签属性，
    //      块内 url(...) 改写为代理路径
    //   3) 其它标签                     → 改写资源属性（含内联 style）
    // 正则从左到右消费字符串，已匹配区域不会二次访问。
    const result = html.replace(
      /(<script\b([^>]*)>)([\s\S]*?)(<\/script>)|(<style\b([^>]*)>)([\s\S]*?)(<\/style>)|<([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/gi,
      (m, sOpen, sAttrs, sInner, sClose, yOpen, yAttrs, yInner, yClose, tag, tagAttrs) => {
        // <script ...>...</script>：改写起始标签的 src，块内 JS 原样保留
        if (sOpen !== undefined) {
          return `<script${rewriteTagAttrs("script", sAttrs || "", target)}>${sInner}${sClose}`;
        }
        // <style ...>...</style>：改写起始标签属性 + 块内 url(...)
        if (yOpen !== undefined) {
          return `<style${rewriteTagAttrs("style", yAttrs || "", target)}>${rewriteCssUrls(yInner || "", target)}${yClose}`;
        }
        // 普通标签：改写资源属性（含内联 style 中的 url(...)）
        return `<${tag}${rewriteTagAttrs(tag, tagAttrs, target)}>`;
      }
    );

    return new Response(result, {
      status: upstream.status,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=300",
        "access-control-allow-origin": "*",
      },
    });
  }

  // 非 HTML（如文本 / 文件下载）：原样透传
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": contentType,
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}
