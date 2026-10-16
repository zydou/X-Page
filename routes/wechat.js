/**
 * routes/wechat.js
 * ============================================================
 * 微信公众号文章专用代理：/wechat/<encodeURIComponent(url)>
 *
 * 与 /html/ 共享抓取 + 资源代理逻辑，唯一差异是给文章标题包上
 * <a href="原文链接">，方便用户在嵌入环境里点标题跳转。
 *
 * 复用方式：通过 serveHtml 的 transform 钩子注入 transformWechat
 * （标题包链接 + Markdown 变体额外删掉两块用户不可见的推广/页脚 DOM）。
 *
 * 内容协商：Accept: text/markdown 时交给 serveHtml 的 Markdown 管线，
 * 返回 Markdown 文本（标题同样包着可点回原文的链接）。
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
 *   - 边缘缓存 no-store：R2 已是永久真相源，边缘副本在本账号 purge 不掉，
 *     「省一次 Worker 调用」换「写坏一次永久错」不划算（头注详）
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

// Markdown 变体要删掉两块微信客户端注入的推广 / 页脚 DOM。两者都带
// style="display: none" —— 用户在浏览器里根本看不到，但 toMarkdown 不做视觉
// 渲染、不认 display:none，会把它们整段抽进 Markdown。
//
// 锚点一律用微信客户端的 JS 钩子 id（js_* / activity-name），不用文案：
// 文案会改，id 是客户端代码要抓的节点，稳定。
const FOOTER_ANCHOR = /<div\b[^>]*\bid="js_tags_preview_toast"/i;
const NOVEL_CARD_ANCHOR = /<div\b[^>]*\bid="js_novel_card"/i;
const CONTENT_ANCHOR = /<div\b[^>]*\bid="js_content"/i;

// 页脚 chrome 起点：它之后全是底部工具栏（修改于 / 不喜欢）、二维码弹窗、
// 分享面板、作者头像等。
function cutWechatFooter(html) {
  const m = FOOTER_ANCHOR.exec(html);
  return m ? html.slice(0, m.index) : html;
}

// 正文前的小说阅读器推广卡片。它紧挨着正文容器，闭合标签就贴在
// #js_content 开标签前面，所以直接切「卡片开头 → 正文开头」这一段，
// 不用数 div 深度。卡片里的「在小说阅读器读本章 / 去阅读 / 在公众号小说中
// 沉浸阅读」正是这样被清掉的；再往前的署名（#meta_content、#js_profile_card）
// 不在这一段内，按用户要求保留。
function cutWechatNovelCard(html) {
  const start = NOVEL_CARD_ANCHOR.exec(html);
  if (!start) return html;
  const end = CONTENT_ANCHOR.exec(html);
  if (!end || end.index < start.index) return html;
  return html.slice(0, start.index) + html.slice(end.index);
}

/**
 * /wechat/ 的 transform 钩子：包标题链接，并在 Markdown 变体上删掉两块
 * 用户不可见的推广 / 页脚 DOM。
 *
 * 只对 Markdown 管线删——HTML 视图里那些 div 本来就是 display:none，
 * 保留它们才能维持 /wechat/「完整渲染原文」的语义。
 *
 * @param {string} html
 * @param {string} target
 * @param {boolean} isMarkdown 是否走 Markdown 管线
 * @returns {string}
 */
function transformWechat(html, target, isMarkdown) {
  const wrapped = wrapTitleLink(html, target);
  if (!isMarkdown) return wrapped;
  return cutWechatFooter(cutWechatNovelCard(wrapped));
}

/**
 * 处理 /wechat/<encoded> 请求。
 *
 * 流程：
 *   0. Accept: text/markdown → 直接交给 serveHtml 的 Markdown 管线返回，
 *      不经过下面这段 HTML 缓存（否则会把缓存 HTML 喂给要 Markdown 的客户端）
 *   1. 查 R2（key = `wechat/<原文URL>`）：命中直接返回缓存 HTML
 *   2. 未命中 → 复用 serveHtml 抓取 + 改写，后台写回 R2
 *   3. 抓取失败（原文删除 / 不可达）→ 原样返回错误（首次无缓存可回退）
 *
 * 无 refresh 入口：命中即缓存，内容以首次抓取为准。
 * Markdown 变体有独立 R2 key（`md/wechat/<原文URL>`），支持 ?refresh= 重转。
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

  // Markdown 协商必须先短路：下面 R2 命中分支会无视 Accept 直接返回缓存 HTML。
  // 交给 serveHtml 的独立管线处理，它按路由前缀隔离出自己的 md/wechat/ R2 key。
  if ((request.headers.get("accept") || "").includes("text/markdown")) {
    return serveHtml(request, env, ctx, transformWechat, "/wechat/");
  }

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
              "cache-control": "no-store",
              "access-control-allow-origin": "*",
              "vary": "Accept",
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
  const resp = await serveHtml(request, env, ctx, transformWechat, "/wechat/");
  if (!resp.ok) return resp;

  const html = await resp.text();
  // 后台写回 R2（不阻塞响应；失败忽略，下次请求重新抓取）
  if (env?.TWEETS && ctx) {
    ctx.waitUntil(
      env.TWEETS.put(r2Key, html, { httpMetadata: { contentType: "text/html" } }).catch(() => {})
    );
  }

  // 边缘 no-store：R2 已是永久真相源，边缘那份副本在本账号 purge 不掉
  // （见 lib/to-markdown.js 的 markdownResponse 头注），留着不划算。
  // Vary: Accept 仍带上——同一 URL 也有 text/markdown 变体，对忽略 no-store
  // 的中间层按 Accept 区分仍是兜底。
  const headers = new Headers(resp.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("vary", "Accept");
  headers.set("x-cache", "miss");
  return new Response(html, { status: resp.status, headers });
}
