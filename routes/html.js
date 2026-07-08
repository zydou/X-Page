/**
 * routes/html.js
 * ============================================================
 * HTML 抓取 + 改写代理：/html/<encodeURIComponent(url)>
 *
 * 解决微信公众号文章被第三方平台（如飞书）服务器 IP 拒绝的问题：
 * 让 Worker 作为中立客户端去抓原文，再喂给嵌入环境。
 *
 * 与 /proxy/ 的关键差异：
 *   1. 可覆盖上游 User-Agent：微信公众号对 UA 白名单限制，
 *      通过 wrangler.toml [vars] UA 变量注入真实浏览器 UA
 *   2. 仅对 text/html 响应做 DOM 改写：给 <img> 加
 *      referrerpolicy="no-referrer"，绕过微信图片防盗链；
 *      非 HTML 资源（纯文本合并 / 文件下载）原样透传
 *   3. 不劫持 Range：HTML 不需要断点续传
 *
 * 被谁调用：
 *   - 入口匹配 /html/ 前缀
 *
 * 路径约定：
 *   Worker 收到的 pathname = "/html/<encoded>"
 * ============================================================
 */

// 微信公众号白名单 UA：iOS 微信内置浏览器。
// 用户可通过 wrangler.toml [vars] UA 覆盖。
const DEFAULT_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 26_5_1 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 " +
  "MicroMessenger/8.0.73(0x18004939) NetType/WIFI Language/zh_CN";

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

  // HTML：改写 <img> 去掉 referrer，其余原样透传
  if (contentType.includes("text/html")) {
    let html = await upstream.text();
    // 只在 <script>...</script> 之外注入 referrerpolicy。
    // 微信等站点的模板 JS 里同样会书写 "<img ...>" 字面值
    // （用字符串拼接动态生成标签），被误改会导致 JS 语法破坏。
    html = html.replace(/(<script[\s\S]*?<\/script>)|<img\b([^>]*)>/gi, (m, script, imgAttrs) => {
      // 命中script块 → 原样保留
      if (script) return m;
      // 命中<img> → 已有 referrerpolicy 则不再重复注入
      if (/referrerpolicy/i.test(imgAttrs)) return m;
      return `<img referrerpolicy="no-referrer"${imgAttrs}>`;
    });
    return new Response(html, {
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
