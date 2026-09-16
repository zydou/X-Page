/**
 * routes/wechat.js
 * ============================================================
 * 微信公众号文章专用代理：/wechat/<encodeURIComponent(url)>
 *
 * 与 /html/ 共享抓取 + 资源代理逻辑，唯一差异是给文章标题包上
 * <a href="原文链接">，方便用户在嵌入环境里点标题跳转。
 *
 * 复用方式：通过 serveHtml 的 transform 钩子注入 wrapTitleLink。
 *
 * 标题 DOM 特征：<h1 class="rich_media_title" id="activity-name">
 * 非微信公众号页面不会命中，退化为与 /html/ 相同行为，不报错。
 * ============================================================
 *
 * ## R2 持久化缓存（复用 tweets 的 R2 绑定）
 *
 * 与 tweets 共用同一个 R2 bucket（x-page，绑定 TWEETS），
 * 仅 key 前缀不同：`tweet/<id>.json` vs `wechat/<原文URL>`。
 * 把渲染后的完整 HTML 存进 R2，命中直接返回缓存——
 * 即使原文被删除，链接依然可读（防失效）。
 *
 *   - R2 持久层：key = `wechat/<原文URL>`，存最终 HTML 文档
 *   - 命中规则：R2 有对象就直接返回，不做应用层过期判断
 *   - 无 refresh 入口：命中即缓存，内容以首次抓取为准（防失效优先）
 *   - 写回不阻塞响应（ctx.waitUntil 后台执行），失败静默忽略
 *
 * 注意：/html/ 路由不缓存，本缓存逻辑只对 /wechat/ 生效。
 * 生命周期：wechat/ 前缀未配置过期规则，默认永久保留（防失效优先）。
 *
 * ## 视频播放（未实现，踩坑记录）
 *
 * 微信公众号文章中的视频无法直接代理播放，调研结论如下。
 *
 * ### 视频加载链路（四层嵌套）
 *
 *   文章 HTML
 *     └─ <iframe data-src="mp.weixin.qq.com/mp/readtemplate?vid=wxv_XXX">   ← 第1层：iframe 懒加载
 *           └─ 播放器模板页面 (player.html.js)
 *                 └─ JS 读取 vid 参数，动态请求视频信息接口
 *                       └─ 返回 http://mpvideo.qpic.cn/....mp4?auth_key=XXX&dis_t=XXX   ← 第2层：动态鉴权 URL
 *
 * ### 尝试过的方案
 *
 * #### 方案 A：代理 mp4 URL 流式传输（不可行）
 *
 * - 真实 mp4 URL 不在文章 HTML 里，是播放器 JS 按 vid 动态向微信后端请求得到的
 * - 需要逆向视频信息接口 + 签名算法（未公开，随时会改）
 * - mp4 托管在 http://mpvideo.qpic.cn（非 HTTPS），裸访返回 403（即使加 Referer 也 403）
 * - 鉴权 token 有效期极短：dis_t 是过期时间戳，实测约 5 分钟就失效
 *   （示例：dis_t=1783578687 → 2026-07-09 06:31，发现时已 06:35 过期）
 * - 即使拿到 URL，还需处理：Range seek 支持、HTTP→HTTPS 升级（mixed content）、Referer 校验
 *
 * #### 方案 B：保留原始 iframe，让微信播放器自己处理（不可行）
 *
 * 思路：iframe 不代理，直接指向 mp.weixin.qq.com，让微信自己的 JS 处理签名/加载。
 *
 * 障碍：播放器模板页面（video_player_tmpl）内有 document.referrer 白名单 gate：
 *
 *   // player.html.js 中的关键代码
 *   if (/^https?:\/\/.+?\.qq\.com\//.test(document.referrer) ||
 *       /^https?:\/\/.+?\.woa\.com\//.test(document.referrer) ||
 *       /^https?:\/\/.+?\.oa\.com\//.test(document.referrer)) {
 *     seajs.use("pages/video_player_tmpl.js");   // ← 只有匹配才加载播放器
 *   }
 *
 * 当 iframe 被嵌入我们的 worker 页面时，iframe 内的 document.referrer = 我们的域名
 * （x.bennydou.workers.dev），不匹配 qq.com/woa.com/oa.com → 播放器 JS 不加载 → 空壳。
 *
 * 这个 referrer 是浏览器自动设置的，worker 无法伪造或修改。
 *
 * ### 关键发现
 *
 * - 播放器页面本身返回 200 且不限制 X-Frame-Options / CSP frame-ancestors
 *   （curl 测试：无论 Referer 是什么都返回 200）
 * - 但播放器初始化依赖 document.referrer 白名单，这是硬门槛
 * - 视频信息接口未知，签名算法未知
 * - mp4 URL 示例：http://mpvideo.qpic.cn/0bc3wiaboaaanmacl5slc5vfbmwdc6zaafya.f10002.mp4
 *   ?dis_k=...&dis_t=...&play_scene=...&auth_info=...&auth_key=...
 *
 * ### 如果以后要做
 *
 * 最可能的突破口（但投入大、脆弱）：
 * 1. 逆向 video_player_tmpl.js，找到"通过 vid 换 mp4 URL"的 API 端点 + 签名算法
 * 2. 在 worker 端实现：收到 wechat 请求 → 解析文章提取所有 vid → 调 API 拿 mp4 URL
 *    → 用 <video> 替换原 iframe，src 指向 /proxy/mp4-url
 * 3. /proxy/ 需扩展：支持 Range 透传、转发正确 Referer、HTTP→HTTPS
 *
 * 当前结论：不值得做。微信视频的多层鉴权 + 域名白名单是有意设计的壁垒。
 */

import { serveHtml } from "./html.js";

/**
 * 把文章标题（h1#activity-name）的正文包上 <a href="原文链接">。
 *
 * @param {string} html 已改写资源路径后的完整 HTML
 * @param {string} target 文章原始 URL，用作 <a> 的 href
 * @returns {string}
 */
function wrapTitleLink(html, target) {
  // 颜色与 water.css --links 一致（#0076d1），和推文作者链接同色
  return html.replace(
    /(<h1\b[^>]*\bid="activity-name"[^>]*>)([\s\S]*?)<\/h1>/i,
    (_match, openTag, inner) =>
      `${openTag}<a href="${target}" target="_blank" style="color:#0076d1;text-decoration:none">${inner.trim()}</a></h1>`
  );
}

/**
 * 处理 /wechat/<encoded> 请求。
 *
 * 流程：
 *   1. 查 R2（key = `wechat/<原文URL>`）：命中直接返回缓存 HTML
 *   2. 未命中 → 复用 serveHtml 抓取 + 改写，后台写回 R2
 *   3. 抓取失败（原文删除 / 不可达）→ 原样返回错误（首次无缓存可回退）
 *
 * 无 refresh 入口：命中即缓存，内容以首次抓取为准。
 *
 * @param {Request} request
 * @param {Object} env 含 R2 绑定 TWEETS（与 tweets 共用同一桶；可空，无绑定则退化为纯代理）
 * @param {Object} ctx Worker ExecutionContext（用于 waitUntil 后台写回）
 * @returns {Response}
 */
export async function serveWechat(request, env, ctx) {
  const url = new URL(request.url);

  // 解析原文 URL。serveHtml 内部会再解析一次，这里为算 R2 key 需提前解出。
  const encoded = url.pathname.slice("/wechat/".length);
  if (!encoded) return new Response("missing url", { status: 400 });
  let target;
  try {
    target = decodeURIComponent(encoded);
  } catch {
    return new Response("bad encoding", { status: 400 });
  }
  if (!/^https?:\/\//i.test(target)) target = "http://" + target;

  // R2 key：直接用原文 URL 作为唯一标识（R2 key 支持任意 UTF-8 字符串）
  const r2Key = "wechat/" + target;

  // 第一步：命中 R2 直接返回缓存（原文删除后依然可读）
  if (env?.TWEETS) {
    const obj = await env.TWEETS.get(r2Key);
    if (obj) {
      try {
        const html = await obj.text();
        if (html) {
          return new Response(html, {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "public, max-age=31556952",
              "access-control-allow-origin": "*",
              "x-cache": "hit",
            },
          });
        }
      } catch {
        // 损坏的缓存忽略，重新抓取
      }
    }
  }

  // 第二步：R2 miss → 抓取 + 渲染（复用 /html/ 的 serveHtml）
  const resp = await serveHtml(request, env, wrapTitleLink, "/wechat/");
  if (!resp.ok) return resp;

  const html = await resp.text();
  // 后台写回 R2（不阻塞响应；失败忽略，下次请求重新抓取）
  if (env?.TWEETS && ctx) {
    ctx.waitUntil(
      env.TWEETS.put(r2Key, html, { httpMetadata: { contentType: "text/html" } }).catch(() => {})
    );
  }

  const headers = new Headers(resp.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "public, max-age=31556952");
  headers.set("x-cache", "miss");
  return new Response(html, { status: resp.status, headers });
}
