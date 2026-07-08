/**
 * routes/image.js
 * ============================================================
 * 图片服务路由：/img/<url>（代理）和 /img/d/<url>（直连）
 *
 * 与 /vid/ 的区别：
 *   - 返回非常轻量的自适应 HTML，全屏居中展示一张图片
 *   - 图片 <a target="_blank"> 包裹，可点击打开原图
 *   - 代理模式同时依赖 /proxy/ 路由"剥离 Content-Disposition: attachment"
 *     上游强制下载的 URL 经过 /proxy/ 后浏览器会以内联方式呈现
 *
 * 典型使用场景：飞书云文档 / Notion 等工具中嵌套的图片预览窗格。
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";

/**
 * 主入口：响应 /img 与 /img/d 请求。
 *
 * 流程：
 *   1. 区分代理 / 直连模式，从路径中取出编码后的 URL
 *   2. 空 URL → 返回使用说明页
 *   3. 校验 URL 必须 http(s) 开头
 *   4. 决定图片源：代理模式 → /proxy/<encoded>；直连模式 → 原始 URL
 *   5. 输出自包含的 viewer HTML
 *
 * @param {Request} request 原始请求
 * @param {string} cleanPath 去首斜杠 + decode 后的路径
 * @param {string} host 请求的 Host 头
 * @returns {Response} 图片预览 HTML 或错误提示
 */
export async function serveImage(_request, cleanPath, host) {
  // 直连模式以 "/img/d" 开头——先判断这个再判断 "/img/"
  const isDirect = cleanPath === "img/d" || cleanPath.startsWith("img/d/");

  let encodedUrl;
  if (isDirect) {
    encodedUrl = cleanPath.slice("img/d/".length);
  } else {
    encodedUrl = cleanPath.slice("img/".length);
  }

  // 无 URL → 使用说明页
  if (!encodedUrl) {
    return new Response(imageIndexHtml(host), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let rawUrl = encodedUrl;
  try {
    rawUrl = decodeURIComponent(encodedUrl);
  } catch (e) {
    /* keep encoded */
  }

  if (!/^https?:\/\//i.test(rawUrl)) {
    return new Response(
      "无效的链接格式。请确保传入的是以 http(s) 开头（或 URL 编码后）的图片直链",
      { status: 400 }
    );
  }

  let imageUrl = rawUrl;
  if (!isDirect) {
    imageUrl = proxyUrl(rawUrl);
  }

  // 极简 viewer：全屏居中、等比缩放、可点开原图
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Image Proxy</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  html, body { margin: 0; padding: 0; overflow: hidden; background: transparent; }
  img { max-width: 100vw; max-height: 100vh; object-fit: contain; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); }
</style>
</head>
<body>
  <a href="${imageUrl}" target="_blank"><img src="${imageUrl}" alt="image" /></a>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html;charset=UTF-8",
      "cache-control": "public, max-age=31556952",
    },
  });
}

/**
 * /img 路径下"无 URL 参数"时的使用说明页。
 *
 * @param {string} host 当前 Worker 的 Host（如 x.example.com）
 * @returns {string} 完整的 HTML 字符串
 */
export function imageIndexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Image Proxy</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px">
  <h2>基于 CF Worker 的图片代理</h2>
  <p>主要应用在飞书云文档中用于内嵌图片链接，以<strong>预览视图</strong>进行展示</p>
  <ul>
      <li><strong>剥离 <code>Content-Disposition: attachment</code></strong>：让浏览器始终以内联方式显示图片</li>
      <li><strong>自适应缩放</strong>：图片按原始比例完整展示</li>
      <li><strong>长缓存</strong>：利用 Cloudflare CDN 缓存图片 1 年，加速二次加载</li>
      <li><strong>直链模式</strong>：<code>/img/d/&lt;url&gt;</code> 路径可直接显示不经过代理的图片</li>
  </ul>
  <h3>使用方法</h3>
  <h4>代理模式（默认）</h4>
  <p><a href="https://${host}/img/https://picsum.photos/800/600">https://${host}/img/https://picsum.photos/800/600</a></p>
  <h4>直连模式</h4>
  <p><a href="https://${host}/img/d/https://picsum.photos/800/600">https://${host}/img/d/https://picsum.photos/800/600</a></p>
  <p>提示：URL 里有 <code>?</code> <code>#</code> 空格、中文等特殊字符时，需要先 <a href="https://meyerweb.com/eric/tools/dencoder/">URL编码</a></p>
  <p>例如：<a href="https://${host}/img/https%3A%2F%2Fpicsum.photos%2F800%3Fblur%3D2">https://${host}/img/https%3A%2F%2Fpicsum.photos%2F800%3Fblur%3D2</a></p>
</body></html>`;
}
