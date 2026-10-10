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
 * 内容协商（Accept: text/markdown）：
 *   带上该头时改走 serveMarkdown——缓冲出完整 HTML、改写完再用 Browser
 *   Run 的 /markdown quick action 转成 Markdown 文本，结果落 R2 后返回。
 *   两条管线各自独立：HTML 走流式改写，Markdown 必须先拿到整篇字符串。
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
import { convertHtml, absolutizeInternal, markdownResponse } from "../lib/browser-run.js";

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
  //
  // 注意：JS / CSS 也需要代理！
  // 原始域名通常有 CORS 限制，直接加载会被浏览器阻断。
  // 代理后虽然 import.meta.url 变成 worker 域名导致内部相对导入错位，
  // 但这个问题已由 /proxy/ 路由中的内容改写（rewriteJsRelativeUrls /
  // rewriteCssRelativeUrls）解决——它会把内容中的相对 URL 改写为绝对代理路径。
  function proxyAttr(el, attr) {
    const val = el.getAttribute(attr);
    if (!val || !shouldProxy(val)) return;
    el.setAttribute(attr, proxyUrl(resolveUrl(val, base)));
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
      // 懒加载兜底：src 为空时补一个 src，避免依赖页面 JS 触发才显示
      //（典型如微信公众号文章的 data-src）。
      //
      // 只有 srcset 没有 src 的情况也必须在 markdown 管线里补上：
      // Browser Run 的转换会丢弃 srcset，产出 ![alt]() 空链接，图片整个丢失
      //（实测：<img srcset="a.jpg 1x, b.jpg 2x" alt="x"> → ![x]()）。
      // 取 srcset 最后一个条目（约定上通常是最清晰的一档），
      // 此时条目已被 proxySrcset 代理成 /proxy/ 路径。
      // 对 HTML 管线无害：srcset 存在时浏览器仍以 srcset 为准。
      if (el.tagName === "img" || el.tagName === "source") {
        if (!el.getAttribute("src")) {
          const ds = el.getAttribute("data-src");
          if (ds) {
            el.setAttribute("src", ds);
          } else {
            const entries = (el.getAttribute("srcset") || "").split(",");
            for (let i = entries.length - 1; i >= 0; i--) {
              const url = entries[i].trim().split(/\s+/)[0];
              if (url) {
                el.setAttribute("src", url);
                break;
              }
            }
          }
        }
      }
    },
  };
  for (const tag of Object.keys(RESOURCE_ATTRS_BY_TAG)) {
    rewriter.on(tag, handler);
  }

  // 1b. <a> 标签：把 href 改写为 /html/<url>，让用户点击后仍留在代理体系内。
  // 相对路径 → 解析为原始域名的绝对 URL → 套上 /html/ 前缀。
  // 已有 /html/ 前缀的不用再处理；javascript: / # 锚点 不处理。
  rewriter.on("a", {
    element(el) {
      const href = el.getAttribute("href");
      if (!href) return;
      const t = href.trim();
      if (!t || /^(javascript:|#|\/html\/)/i.test(t)) return;
      const absolute = resolveUrl(t, base);
      el.setAttribute("href", "/html/" + absolute);
    },
  });

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
 * 抓取上游页面。/html/ 与 /wechat/ 都靠自定义 UA + Referer 才能绕过
 * 微信白名单，两条管线共用同一套请求头，抽出来避免两边各写一份而漂移。
 *
 * @param {string} target 目标 URL（已保证带 http(s):// 前缀）
 * @param {string} ua 请求头用的 User-Agent
 * @returns {Promise<Response>}
 */
async function fetchUpstream(target, ua) {
  return fetch(target, {
    headers: {
      "user-agent": ua,
      // 微信文章页对 referer 也有校验，塞一个自家域名降低被拒概率
      referer: new URL(target).origin + "/",
    },
  });
}

/**
 * Accept: text/markdown 的完整管线：
 *
 *   R2 查缓存 → 抓上游 → buildRewriter 改写资源 → 绝对化内部路径
 *   → Browser Run 转换 → 写回 R2
 *
 * 免费套餐 Quick Actions 每 10 秒 1 次、浏览器时间 10 分钟/天，
 * 因此必须先查 R2：命中则零配额直接返回，未命中才转换一次并写回。
 *
 * 与 HTML 管线的两点差异：
 *   - 必须缓冲出完整 HTML 字符串（quickAction 的 html= 需要整篇），
 *     所以 HTML 那条零缓冲的流式输出路径在这里不可用
 *   - 转换失败时不降级成 HTML——返回明确的 502，让调用方能区分
 *     「这条 URL 暂时没有 Markdown」与「页面本身挂了」
 *
 * @returns {Response}
 */
async function serveMarkdown(request, env, ctx, target, prefix, transform, ua) {
  const url = new URL(request.url);
  const bucket = env && env.TWEETS;
  // 按路由前缀隔离 key，/html/ 与 /wechat/ 的转换结果互不覆盖
  const mdKey = "md/" + prefix.replace(/\/+/g, "") + "/" + target;
  // ?refresh= 强制重新转换，是 R2 永不过期带来的唯一逃生口
  const refresh = url.searchParams.has("refresh");

  // 1. R2 命中 → 直接返回，不消耗任何浏览器配额
  if (bucket && !refresh) {
    const obj = await bucket.get(mdKey);
    if (obj) {
      const cached = await obj.text();
      if (cached) return markdownResponse(cached, "hit");
    }
  }

  // 2. 未命中 → 抓上游
  const upstream = await fetchUpstream(target, ua);
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, { status: upstream.status });
  }
  if (!(upstream.headers.get("content-type") || "").includes("text/html")) {
    return new Response("not html", { status: 406 });
  }

  // 3. 缓冲 + 改写资源路径，再补全内部 /proxy/ /html/ 的绝对地址
  //    这里 content-type 只给 "text/html"：HTMLRewriter 不接受显式 charset
  //    （会抛 "Unknown character encoding"），与上面流式路径保持同一写法。
  let fed;
  try {
    const html = await (
      await buildRewriter(target).transform(
        new Response(upstream.body, { status: upstream.status, headers: new Headers({ "content-type": "text/html" }) })
      )
    ).text();
    fed = absolutizeInternal(transform ? transform(html, target) : html, url.origin);
  } catch (e) {
    return new Response("rewrite failed: " + (e && e.message ? e.message : String(e)), {
      status: 502,
    });
  }

  // 4. 转换（免费套餐配额的唯一消耗点）
  let md;
  try {
    md = await convertHtml(env.BROWSER, fed);
  } catch (e) {
    const msg = "markdown conversion failed: " + (e && e.message ? e.message : String(e));
    // 免费套餐是 1 次/10 秒，Agent 批量抓取必然撞 429。此时透传 429 +
    // Retry-After 让客户端按语义退避，而不是当成服务器故障立刻重试白撞。
    // 注意此时没有写 R2，所以退避后的重试会真正重新转换。
    if (e && e.status === 429) {
      return new Response(msg, { status: 429, headers: { "retry-after": e.retryAfter || "10" } });
    }
    return new Response(msg, { status: 502 });
  }

  // 5. 写回 R2（后台执行，失败不影响本次响应）
  if (bucket && ctx) {
    ctx.waitUntil(bucket.put(mdKey, md, { httpMetadata: { contentType: "text/markdown" } }).catch(() => {}));
  }

  const resp = markdownResponse(md, "miss");
  // refresh 变体不进边缘缓存，否则第二次 ?refresh=1 会拿到边缘的陈旧副本、
  // 转换压根没跑（实测：cf-cache-status: HIT）。与推文路由的 max-age=0 语义一致。
  if (refresh) resp.headers.set("cache-control", "public, max-age=0");
  return resp;
}

/**
 * 处理 /html/<encoded> 请求。
 *
 * @param {Request} request 入站请求
 * @param {Object} env wrangler 注入的环境变量（含 vars + secrets）
 * @param {ExecutionContext} ctx Workers 执行上下文，供 Markdown 管线后台写 R2
 * @param {(html: string, target: string) => string} [transform] 对最终 HTML 的可选改写钩子
 * @param {string} [prefix="/html/"] 路由前缀，调用方按自己路径传入（如 "/wechat/"）
 * @returns {Response}
 */
export async function serveHtml(request, env, ctx, transform, prefix = "/html/") {
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

  // Accept: text/markdown → 走独立管线（R2 命中时完全不碰上游）
  if ((request.headers.get("accept") || "").includes("text/markdown")) {
    return serveMarkdown(request, env, ctx, target, prefix, transform, ua);
  }

  const upstream = await fetchUpstream(target, ua);

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
  // 同一 URL 现在有两种表示，边缘必须按 Accept 区分，
  // 否则会把 HTML 直接喂给要 Markdown 的客户端。
  headers.set("vary", "Accept");

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
    const fallback = await fetchUpstream(target, ua);
    const rawHtml = await fallback.text();
    const finalHtml = transform ? transform(rawHtml, target) : rawHtml;
    return new Response(finalHtml, { status: upstream.status, headers });
  }
}
