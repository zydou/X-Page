/**
 * routes/video.js
 * ============================================================
 * 视频服务路由：/vid/<url>（代理）和 /vid/d/<url>（直连）
 *
 * 行为：
 *   - /vid/       无 URL 时返回使用说明页；有 URL 时返回 Artplayer HTML
 *   - /vid/d/     无 URL 时返回使用说明页；有 URL 时返回 Artplayer HTML
 *     两者的区别仅在于 player 的实际视频源：
 *       代理模式 → /proxy/<encoded>（走 Worker 缓存 + 防盗链绕过）
 *       直连模式 → 直接用原始 URL（不做代理，适用无防盗链场景）
 *
 * Artplayer 库作为外部 JS 资产，由 worker.js 入口处通过 Text module
 * 机制导入后当作参数注入；本文件保持无 import Artplayer 的姿态，
 * 便于单独测试和资产热替换。
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";

/**
 * 判断路径是否以 /vid/d（直连模式）开头。
 *
 * 路径在进入本路由时已被 worker.js 去掉首斜杠并过一次 decode：
 *   - "vid/d"       → 只有前缀无 URL（显示使用说明）
 *   - "vid/d/<url>" → 直连视频播放
 *
 * @param {string} cleanPath 去首斜杠 + decode 后的路径
 * @returns {boolean}
 */
export function isDirectVideo(cleanPath) {
  return cleanPath === "vid/d" || cleanPath.startsWith("vid/d/");
}

/**
 * 主入口：响应 /vid 与 /vid/d 请求。
 *
 * 流程：
 *   1. 区分代理 / 直连模式，从路径中取出编码后的 URL
 *   2. 空 URL → 返回使用说明页
 *   3. 校验 URL 必须 http(s) 开头（或编码后等价形态）
 *   4. 决定播放源：代理模式 → /proxy/<encoded>；直连模式 → 原始 URL
 *   5. 把 artplayer 源码直接内联到 HTML <script> 中，做到自包含
 *
 * @param {Request} request 原始请求
 * @param {string} cleanPath 去首斜杠 + decode 后的路径
 * @param {string} host 请求的 Host 头（用于使用说明页生成示例链接）
 * @param {string} artplayerJs 由 worker.js 注入的 Artplayer 库源码字符串
 * @returns {Response} Artplayer 播放器 HTML 或错误提示
 */
export async function serveVideo(_request, cleanPath, host, artplayerJs) {
  const isDirect = isDirectVideo(cleanPath);

  // 根据模式决定截取前缀的长度，拿掉 "vid/" 或 "vid/d/"
  let encodedUrl;
  if (isDirect) {
    encodedUrl = cleanPath.slice("vid/d/".length);
  } else {
    encodedUrl = cleanPath.slice("vid/".length);
  }

  // 无 URL → 使用说明页
  if (!encodedUrl) {
    return new Response(videoIndexHtml(host), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 尝试解码；失败也保留原值，后续正则再检查合法性
  let rawUrl = encodedUrl;
  try {
    rawUrl = decodeURIComponent(encodedUrl);
  } catch (e) {
    /* keep encoded */
  }

  // 没有协议头的裸地址（如 example.com/vid.mp4）默认补上 http://
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = "http://" + rawUrl;
  }

  // 决定最终喂给播放器的 URL
  let playerUrl = rawUrl;
  if (!isDirect) {
    playerUrl = proxyUrl(rawUrl);
  }

  // HTML 完全自包含：Artplayer 源码直接内联在 <script> 里
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8" />
<title>Video Player</title>
<meta content="width=device-width,initial-scale=1.0" name=viewport>
<style>.artplayer{aspect-ratio:16/9;}</style>
</head>
<body>
<div class="artplayer"></div>
<script>
${artplayerJs}
Artplayer.ASPECT_RATIO = ["default", "1:1", "3:4", "4:3", "9:16", "16:9"];
Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3];
const art = new Artplayer(
    {
    container: ".artplayer",
    url: "${playerUrl}",
    playbackRate: true,
    aspectRatio: true,
    setting: true,
    fullscreen: true,
    miniProgressBar: true,
    lang: "zh-cn",
    }
);
</script>
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
 * /vid 路径下"无 URL 参数"时的使用说明页。
 *
 * 静态模板不依赖任何外部资源，直接内联在工作流返回里。
 * host 参数用于生成用户可直接点进去看效果的演示链接。
 *
 * @param {string} host 当前 Worker 的 Host（如 x.example.com）
 * @returns {string} 完整的 HTML 字符串
 */
export function videoIndexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>ArtPlayer</title></head><body style=\"font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 16px\">
  <h2>ArtPlayer Worker</h2>
  <ul>
      <li><strong>视频代理</strong>：通过 Worker 代理视频流，绕过大多数视频站的防盗链/跨域限制</li>
      <li><strong>长缓存</strong>：利用 Cloudflare CDN 缓存视频 1 年，加速二次加载</li>
      <li><strong>直链模式</strong>：<code>/vid/d/&lt;url&gt;</code> 路径可直接播放不经过代理的视频</li>
  </ul>
  <h3>使用方法</h3>
  <h4>代理模式（默认）</h4>
  <p><a href="https://${host}/vid/https://lorem.video/720p">https://${host}/vid/https://lorem.video/720p</a></p>
  <p>视频会被 Worker 代理加载，绕过站的反爬限制。</p>
  <h4>直连模式</h4>
  <p><a href="https://${host}/vid/d/https://lorem.video/720p">https://${host}/vid/d/https://lorem.video/720p</a></p>
  <p>绕过 Worker 代理，直接使用视频原始链接播放（适用于没有限制的场景）。</p>
  <p><small>提示：URL 里有 <code>?</code> <code>#</code> 空格、中文等特殊字符时，需要先 <code>URL编码</code>。</small></p>
  <p><small><a href="https://meyerweb.com/eric/tools/dencoder/">URL编码工具</a></small></p>
  <p>例如：<a href="https://${host}/vid/https%3A%2F%2Florem.video%2F720p">https://${host}/vid/https%3A%2F%2Florem.video%2F720p</a></p>
</body></html>`;
}
