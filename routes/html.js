/**
 * routes/html.js
 * ============================================================
 * HTML 抓取 + 资源代理：/html/<encodeURIComponent(url)>
 *
 * 让 Worker 作为中立客户端抓取任意网页，把所有远程资源 URL
 * 重写为内部 /proxy/<encoded> 路径后返回。
 *
 * 与 /proxy/ 的差异：
 *   - 可覆盖 User-Agent（默认 iOS 微信 UA，可通过 [vars] UA 覆盖）
 *   - 仅对 text/html 做资源改写；非 HTML 原样透传
 *
 * 实现：使用 Cloudflare 原生 HTMLRewriter（流式、零依赖、自动解码
 * 实体），避免手写正则的脆弱性（误匹配 data-src、漏解 &amp; 等）。
 *
 * 资源改写范围：
 *   <img src/data-src/srcset>  <script src>  <link href>
 *   <video src/poster>  <audio src>  <source src/data-src/srcset>
 *   <embed src>  <object data>  <iframe src>  <track src>
 *   <style> 块与内联 style 属性中的 url(...)
 *
 * 懒加载兜底：<img>/<source> 若 src 为空但 data-src 有值，
 * 把后者复制给前者，避免依赖页面 JS 触发才显示。
 *
 * 好处：
 *   1. Worker 发请求不带 Referrer，绕过微信图片防盗链
 *   2. Cloudflare 边缘加速，境外资源国内也能快速访问
 *
 * 被谁调用：
 *   - 入口直接匹配 /html/ 前缀
 *   - /wechat/ 通过 transform 钩子复用本模块
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";

// 默认 UA：iOS 微信内置浏览器，可通过 wrangler.toml [vars] UA 覆盖
const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";

/**
 * 标签 → 其取值当作远程资源 URL 的属性名。
 */
const RESOURCE_ATTRS_BY_TAG = {
  img: ["src", "data-src", "srcset"],
  script: ["src"],
  link: ["href"],
  video: ["src", "poster"],
  audio: ["src"],
  source: ["src", "data-src", "srcset"],
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
 * 改写属性文本中任意 url(...) 引用（CSS 背景图、字体等）。
 *
 * @param {string} text
 * @param {string} base
 * @returns {string}
 */
function rewriteCssUrls(text, base) {
  return text.replace(
    /url\(\s*(["']?)([^"')\s]+)\1\s*\)/gi,
    (m, _q, url) => {
      if (!shouldProxy(url)) return m;
      return `url("${proxyUrl(resolveUrl(url, base))}")`;
    }
  );
}

/**
 * 构建一个配置好的 HTMLRewriter，封装所有资源改写逻辑。
 *
 * @param {string} base 被代理页的完整 URL（用于解析相对路径）
 * @returns {HTMLRewriter}
 */
function buildRewriter(base) {
  const rewriter = new HTMLRewriter();

  // 代理单个普通属性（src / href / data-src / poster / data）
  function proxyAttr(el, attr) {
    const val = el.getAttribute(attr);
    if (val && shouldProxy(val)) {
      el.setAttribute(attr, proxyUrl(resolveUrl(val, base)));
    }
  }

  // 代理 srcset（逗号分隔的 "url [descriptor]" 列表）
  function proxySrcset(el) {
    const val = el.getAttribute("srcset");
    if (!val) return;
    const next = val
      .split(",")
      .map((entry) => {
        const parts = entry.trim().split(/\s+/);
        if (!parts[0]) return entry;
        if (!shouldProxy(parts[0])) return entry;
        parts[0] = proxyUrl(resolveUrl(parts[0], base));
        return parts.join(" ");
      })
      .join(", ");
    if (next !== val) el.setAttribute("srcset", next);
  }

  // 1. 资源标签：按 tagName 改写对应属性
  // 注意 HTMLRewriter 不支持 "a, b, c" 多选择器，需逐个注册；
  // 用 element.tagName 分发到对应的属性列表。
  const handler = {
    element(el) {
      const attrs = RESOURCE_ATTRS_BY_TAG[el.tagName];
      if (!attrs) return;
      for (const a of attrs) {
        if (a === "srcset") proxySrcset(el);
        else proxyAttr(el, a);
      }
      // 懒加载兜底：src 为空但 data-src 有值时，把后者复制给前者，
      // 避免依赖页面 JS 触发才显示（典型如微信公众号文章）。
      if (el.tagName === "img" || el.tagName === "source") {
        const ds = el.getAttribute("data-src");
        const src = el.getAttribute("src");
        if (ds && !src) el.setAttribute("src", ds);
      }
    },
  };
  for (const tag of Object.keys(RESOURCE_ATTRS_BY_TAG)) {
    rewriter.on(tag, handler);
  }

  // 2. <style> 块：改写其中的 url(...)
  rewriter.on("style", {
    text(chunk) {
      if (!chunk.text) return;
      const replaced = rewriteCssUrls(chunk.text, base);
      if (replaced !== chunk.text) chunk.replace(replaced);
    },
  });

  // 3. 内联 style 属性：改写其中的 url(...)
  rewriter.on("[style]", {
    element(el) {
      const s = el.getAttribute("style");
      if (!s) return;
      const r = rewriteCssUrls(s, base);
      if (r !== s) el.setAttribute("style", r);
    },
  });

  return rewriter;
}

/**
 * 处理 /html/<encoded> 请求。
 *
 * @param {Request} request 入站请求
 * @param {Object} env wrangler 注入的环境变量（含 vars + secrets）
 * @param {(html: string, target: string) => string} [transform] 对最终 HTML 的可选改写钩子
 * @param {string} [prefix="/html/"] 路由前缀，调用方按自己路径传入（如 "/wechat/"）
 * @returns {Response}
 */
export async function serveHtml(request, env, transform, prefix = "/html/") {
  const url = new URL(request.url);
  const encoded = url.pathname.slice(prefix.length);
  if (!encoded) return new Response("missing url", { status: 400 });

  let target;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response("bad encoding", { status: 400 });
  }
  if (!/^https?:\/\//i.test(target)) {
    target = "http://" + target;
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

  // 统一响应头。
  // 注意：content-type 必须去掉 charset=... 部分，否则 HTMLRewriter
  // 会抛 "Unknown character encoding"（它不接受显式字符集声明）。
  const headers = new Headers();
  headers.set("content-type", "text/html");
  headers.set("cache-control", "public, max-age=300");
  headers.set("access-control-allow-origin", "*");

  // 非 HTML（如文本 / 文件下载）：原样透传
  if (!contentType.includes("text/html")) {
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  try {
    // HTML：用 HTMLRewriter 流式改写资源路径
    const rewriter = buildRewriter(target);

    if (transform) {
      // 有后处理钩子（如 /wechat/ 包标题链接）：需缓冲后应用
      const transformed = rewriter.transform(
        new Response(upstream.body, { status: upstream.status, headers })
      );
      const html = await transformed.text();
      const finalHtml = transform(html, target);
      return new Response(finalHtml, { status: upstream.status, headers });
    }

    // 无钩子：直接流式输出，零额外内存
    return rewriter.transform(
      new Response(upstream.body, { status: upstream.status, headers })
    );
  } catch (e) {
    // 改写失败时降级：重新请求一次，直接返回原始 HTML，保证页面至少能看
    const fallback = await fetch(target, {
      headers: { "user-agent": ua, referer: new URL(target).origin + "/" },
    });
    const rawHtml = await fallback.text();
    const finalHtml = transform ? transform(rawHtml, target) : rawHtml;
    return new Response(finalHtml, { status: upstream.status, headers });
  }
}
