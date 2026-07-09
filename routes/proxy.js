/**
 * routes/proxy.js
 * ============================================================
 * 通用媒体代理路由：/proxy/<encodeURIComponent(url)>
 *
 * 职责：
 *   1. 从路径取出编码后的目标 URL 并解码
 *   2. 校验协议只允许 http(s)
 *   3. 透传 Range 请求头（视频拖拽播放必须）
 *   4. 向上游发起请求，通过 Cloudflare Cache API 强制缓存 1 年
 *   5. 改写响应头：写死 1 年 immutable 缓存、强制 inline 展示、开放 CORS
 *
 * 被谁调用：
 *   - 入口直接匹配 /proxy/ 前缀
 *   - video / image / tweet 路由内部通过 proxyUrl() 间接引用
 *
 * 路径约定：
 *   Worker 收到的 pathname = "/proxy/<encoded>"
 *   本路由只关心 "/proxy/" 之后的内容
 * ============================================================
 */

/**
 * 处理 /proxy/<encoded> 请求，返回代理后的上游资源。
 *
 * 设计取舍：
 *   - 不设 platform fetch 超时：大视频回源慢，让 Cloudflare 自身约 100s 的
 *     请求超时兜底，我们自己不抢跑，避免误杀慢速但合法的源
 *   - 不 pass-through cache-control：上游值不可信，基于内容 hash 的媒体 URL
 *     一旦写入就不变，直接写死 "immutable" 让浏览器在有效期内连条件请求都不发
 *   - 强制 content-disposition: inline：上游若返回 attachment（强制下载），
 *     这里把它覆盖成 inline，让浏览器直接渲染——这是 /img/ 路由"剥离 attachment"
 *     体验能成立的基础
 *
 * @param {Request} request 原始请求，可能携带 Range 头（视频断点续传）
 * @returns {Response} 代理后的流式响应，或 4xx 错误
 */
export async function handleProxy(request) {
  const url = new URL(request.url);

  // pathname = "/proxy/<encoded>" → 取 "/proxy/" 之后的部分再 decode
  const encoded = url.pathname.slice("/proxy/".length);
  if (!encoded) return new Response("missing url", { status: 400 });

  let target;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response("bad encoding", { status: 400 });
  }

  // 没有协议头的裸地址（如 example.com/path）默认补上 http://，
  // 提升用户对"直接粘域名"场景的容错。明确写了 https:// 的保持不变。
  if (!/^https?:\/\//i.test(target)) {
    target = "http://" + target;
  }

  // 透传 Range 请求头——视频拖拽播放必需
  const headers = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;

  // cf 选项声明「此响应可以缓存在 CDN 边缘」，缓存键 = 完整 URL + vary 头
  const upstream = await fetch(target, {
    headers,
    cf: {
      cacheTtl: 31556952, // 1 年（秒）
      cacheEverything: true,
    },
  });

  // 上游异常直接短路返回其状态码，不做多余包装
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, { status: upstream.status });
  }

  // 构建下游响应头：保留必要的描述头，覆盖缓存 / CORS / Content-Disposition
  const out = new Headers();
  const passThrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ];
  for (const k of passThrough) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  out.set("cache-control", "public, max-age=31556952, immutable");
  out.set("access-control-allow-origin", "*"); // 放宽 CORS，让 HTML 内 <img>/<video> 跨子域呈现
  out.set("content-disposition", "inline"); // 强制 inline，覆盖上游 attachment

  // JS / CSS：改写内容为相对路径 → 绝对代理路径，解决 Vite 等构建工具
  // 产出的相对 chunk 导入（import("./vendor.js")）在代理后解析错位的问题。
  const contentType = (out.get("content-type") || "").toLowerCase();
  const isJs =
    contentType.includes("javascript") ||
    target.endsWith(".js") ||
    target.endsWith(".mjs");
  const isCss = contentType.includes("text/css") || target.endsWith(".css");

  if (isJs || isCss) {
    const baseDir = target.includes("/")
      ? target.slice(0, target.lastIndexOf("/") + 1)
      : target + "/";
    let text = await upstream.text();
    if (isJs) {
      text = rewriteJsRelativeUrls(text, baseDir);
    } else {
      text = rewriteCssRelativeUrls(text, baseDir);
    }
    out.delete("content-length"); // 内容已改变
    return new Response(text, { status: upstream.status, headers: out });
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

/**
 * 改写 JS 中的相对 URL 为绝对代理 URL。
 * 覆盖 Vite 常见的几种写法：
 *   import("./foo.js") , import('./foo.js') , import(`./foo.js`)
 *   from"./foo.js"       , from'./foo.js'       , from`./foo.js`
 *   import.meta 相关的动态拼接不做处理（极少见）
 */
function rewriteJsRelativeUrls(src, baseDir) {
  const proxy = (rel) => "/proxy/" + encodeURIComponent(resolveUrl(rel, baseDir));
  // import("relative") / import('relative') / import(`relative`)
  src = src.replace(
    /import\s*\(\s*(["'`])((?!\/\/)[^"'`]+?)\1\s*\)/g,
    (m, q, path) => (/^(https?:)?\/\//.test(path) ? m : `import(${q}${proxy(path)}${q})`)
  );
  // from"relative" / from'relative' / from`relative`
  src = src.replace(
    /from\s*(["'`])((?!\/\/)[^"'`]+?)\1/g,
    (m, q, path) => (/^(https?:)?\/\//.test(path) ? m : `from${q}${proxy(path)}${q}`)
  );
  // export ... from"relative" 同样处理
  src = src.replace(
    /export\s+(?:\*|\{[^}]*\})\s+from\s*(["'`])((?!\/\/)[^"'`]+?)\1/g,
    (m, q, path) =>
      /^(https?:)?\/\//.test(path) ? m : `export * from${q}${proxy(path)}${q}`
  );
  return src;
}

/**
 * 改写 CSS 中的相对 url(...) 为绝对代理 URL。
 */
function rewriteCssRelativeUrls(src, baseDir) {
  const proxy = (rel) => "/proxy/" + encodeURIComponent(resolveUrl(rel, baseDir));
  return src.replace(
    /url\(\s*(["']?)((?!\/\/)[^"')]+?)\1\s*\)/g,
    (m, q, path) =>
      /^(https?:)?\/\//.test(path) || path.startsWith("data:") ? m : `url(${q}${proxy(path)}${q})`
  );
}

/**
 * 把可能为相对路径的 URL 解析为绝对 URL。
 */
function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}
