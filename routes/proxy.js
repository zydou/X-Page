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

  // 安全基线：只允许 http(s)，避免 file:/javascript: 等 scheme 被利用
  if (!/^https?:\/\//i.test(target)) {
    return new Response("only http(s) urls are allowed", { status: 400 });
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

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
}
