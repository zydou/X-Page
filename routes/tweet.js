/**
 * routes/tweet.js
 * ============================================================
 * X / Twitter 推文 → 自包含 HTML 的主路由。
 *
 * 路由形态：/<username>/status/<tweet_id>
 *
 * 完整渲染流水线：
 *   1. extractPid()           从路径提取推文 ID
 *   2. publish()              调 fxtwitter API 拉取 thread + 推文详情
 *   3. parseArticle()         解析 Twitter Article 长文为 HTML
 *   4. buildMediaTag()        拼出推文内图片 / 视频的画廊片段
 *   5. wrapHtml()             用 water.css + twitter.css 包裹生成最终页
 *
 * 资产注入：
 *   - waterCss / twitterCss 由 worker.js 通过参数注入
 *   - proxyUrl 等工具函数来自 lib/utils.js
 *
 * 文件较大（约 280 行），但逻辑上是单一推事的"内部流水线"：
 * 一个入口的产出是下一个阶段的输入，拆分反而增加跳转成本。
 * ============================================================
 */

import {
  extractPid,
  formatDate,
  makeUrlClickable,
  authorTag,
  buildMediaTag,
  proxyUrl,
} from "../lib/utils.js";

/**
 * 推文字号解析：内联样式的 <b>/<i> 渲染。
 *
 * 在 RawText 实体里，文本片段由 inlineStyleRanges 描述，
 * 每个 range = { offset, length, style }。为避免朴素替换引
 * 起的字符串错位，本函数采用"在字符间隙插标签"的策略：
 *
 *   text = "abc"，range = { start:1, length:1, style:"bold" }
 *   → 拆成 positions 0/1/2/3 四个"缝隙"
 *   → 在 position 1 插入 <b>，在 position 2 插入 </b>
 *   → 最终得到 "a<b>b</b>c"
 *
 * 多段样式在同一位置开启 / 闭合时：
 *   - 同一位置多个起始标签按 styles 数组顺序排列
 *   - 同一位置多个闭合标签用 unshift 反向排列，
 *     保证嵌套结构正确（后开的先闭）。
 *
 * @param {string} text 未经 HTML 转义的原始文本片段
 * @param {Array<{style: string, offset: number, length: number}>} styles 样式范围列表
 * @returns {string} 打上 <b>/<i> 标签的 HTML 片段
 */
function inlineStyle(text, styles) {
  if (typeof text !== "string" || !text.trim()) return "";
  styles = styles || [];
  const n = text.length;

  // 每个字符位置上的"起始标记"和"结束标记"
  const prefixes = Array.from({ length: n + 1 }, () => []);
  const suffixes = Array.from({ length: n + 1 }, () => []);

  for (const style of styles) {
    const s = (style.style || "").toLowerCase();
    const start = style.offset;
    const end = start + style.length;
    let tagStart = "";
    let tagEnd = "";
    if (s === "bold") {
      tagStart = "<b>";
      tagEnd = "</b>";
    } else if (s === "italic") {
      tagStart = "<i>";
      tagEnd = "</i>";
    }
    if (tagStart) {
      prefixes[start].push(tagStart);
      suffixes[end].unshift(tagEnd); // 反向闭合，保证嵌套正确
    }
  }

  let out = "";
  for (let i = 0; i <= n; i++) {
    out += suffixes[i].join(""); // 先闭合
    out += prefixes[i].join(""); // 再开启
    if (i < n) out += text[i];
  }
  return out;
}

/**
 * 解析 Twitter Article（长文推文）为 HTML 片段。
 *
 * Twitter Article 的内容模型是 Draft.js 风格的 block 数组：
 *   blocks[] = { type, text, inlineStyleRanges, entityRanges[] }
 *   entityMap = { key: { type, data } }
 *
 * block.type 含义：
 *   - header-one/two/three/four → <h2>..<h4>
 *   - blockquote             → <blockquote>
 *   - ordered-list-item /
 *     unordered-list-item     → "・" + 前缀
 *   - atomic                 → 实体引用（媒体/引用/Markdown 代码块…）
 *   - 其他                   → <p> 段落
 *
 * atomic 块的实体类型由 parseAtomic 处理。
 *
 * cover_media / media_entities 里的图视频资源统一收拢到 mediaList，
 * 再依据 entity.key 匹配到具体的 <img> / <video> 节点。
 *
 * @param {Object} article fxtwitter API 返回的 post.article 对象
 * @param {string} tweetUrl 所属推文的链接（用于标题 <a> 可点击）
 * @returns {string} 自包含的 HTML 片段
 */
function parseArticle(article, tweetUrl) {
  // 收拢 article 内的静态媒体，key 为 media_id；不是 tweet gallery 的那份
  const mediaList = [];
  for (const media of article?.media_entities || []) {
    // 优先取 mp4 视频，没有再退回原始图片
    const variants = ((media?.media_info?.variants ?? []).filter(
      (x) => x.content_type === "video/mp4"
    ));
    if (variants.length) {
      variants.sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));
      const videoUrl = variants[0]?.url ?? "";
      if (videoUrl) mediaList.push({ url: videoUrl, type: "video", media_id: media.media_id });
    } else {
      const imgUrl = media?.media_info?.original_img_url ?? "";
      if (imgUrl) mediaList.push({ url: imgUrl, type: "photo", media_id: media.media_id });
    }
  }

  // Draft.js 实体字典：可能是数组或对象，统一做成 { key: entity }
  const entityMap = article?.content?.entityMap ?? {};
  const entityDict = {};
  if (Array.isArray(entityMap)) {
    for (const x of entityMap) entityDict[String(x.key)] = x.value;
  } else {
    for (const k in entityMap) entityDict[String(k)] = entityMap[k];
  }

  /**
   * 解析 atomic 块内引用的单个实体列表。
   *
   * 支持的实体类型：
   *   - MEDIA     → 图或视频（在 mediaList 里做 media_id 匹配）
   *   - DIVIDER   → 空行分隔符（输出 \n，由上层折行）
   *   - TWEET     → 引用推文，输出 <a> 外链
   *   - MARKDOWN  → 代码块：第一行是语言标记，后续为代码体；
   *                  反引号 `` ` `` 被剔除，避免和 <pre> 嵌套打架；
   *                  没有语言标记时回退为 <pre> 纯文本
   *
   * @param {Array<{key: number}>} entities atomic 块的 entityRanges
   * @returns {string} 拼接后的 HTML 文本
   */
  function parseAtomic(entities) {
    if (!entities || !entities.length) return "";
    let texts = "";
    for (const x of entities) {
      const entity = entityDict[String(x.key)];
      if (!entity) continue;
      const eType = (entity.type || "").toUpperCase();
      if (eType === "MEDIA") {
        const mediaId = entity?.data?.mediaItems?.[0]?.mediaId ?? "";
        const photo = mediaList.find((m) => m.type === "photo" && m.media_id === mediaId);
        if (photo) {
          texts += `\n<img src="${proxyUrl(photo.url)}" loading="lazy" />`;
        } else {
          const vid = mediaList.find((m) => m.type === "video" && m.media_id === mediaId);
          if (vid) texts += `\n<video src="${proxyUrl(vid.url)}" controls class="tweet-media"></video>`;
        }
      } else if (eType === "DIVIDER") {
        texts += "\n";
      } else if (eType === "TWEET") {
        const tweetId = entity?.data?.tweetId ?? "";
        if (tweetId) texts += `\n<a href="https://x.com/i/status/${tweetId}">QuoteTweet</a>`;
      } else if (eType === "MARKDOWN") {
        // 剔除反引号，避免与 <pre> 内容冲突
        const markdown = (entity?.data?.markdown ?? "").replace(/`/g, "");
        const idx = markdown.indexOf("\n");
        let lang, raw;
        if (idx >= 0) {
          lang = markdown.slice(0, idx);
          raw = markdown.slice(idx + 1);
        } else {
          lang = "";
          raw = markdown;
        }
        if (lang) texts += `\n<pre language="${lang}">${raw}</pre>`;
        else texts += `\n<pre>${markdown}</pre>`;
      }
    }
    return texts.trim();
  }

  // 开始拼装 HTML，先放封面图
  let html = "";
  const coverUrl = article?.cover_media?.media_info?.original_img_url ?? "";
  if (coverUrl) html += `\n<img src="${proxyUrl(coverUrl)}" loading="lazy" />`;

  // 逐 block 渲染
  for (const block of article?.content?.blocks ?? []) {
    const text = inlineStyle(block.text, block.inlineStyleRanges);
    const entities = block.entityRanges || [];
    switch (block.type) {
      case "header-one":
      case "header-two":
        html += `\n<h2>${text}</h2>`;
        break;
      case "header-three":
        html += `\n<h3>${text}</h3>`;
        break;
      case "header-four":
        html += `\n<h4>${text}</h4>`;
        break;
      case "blockquote":
        html += `\n<blockquote>${text}</blockquote>`;
        break;
      case "ordered-list-item":
      case "unordered-list-item":
        html += `\n・${text}`;
        break;
      case "atomic":
        html += `\n${parseAtomic(entities)}`;
        break;
      default:
        html += text ? `\n<p>${text}</p>` : "";
    }
  }

  const title = article.title || "Twitter Article";
  return `<h2><a href="${tweetUrl}">${title}</a></h2>${html}`;
}

/**
 * 推文主流程：调 fxtwitter API 并拼出整页 thread HTML。
 *
 * fxtwitter API 说明：
 *   - /2/thread/<id>     返回 { status, thread[] }，thread 是按时间排序的多条推文
 *   - ?lang=zh-cn        启用翻译字段（data.translation.text）
 *
 * 渲染顺序：
 *   1. 拉取 thread API
 *   2. 按 created_timestamp 从小到大排序（thread 不一定有序）
 *   3. 每条 post：头部（authorTag）+ 正文（makeUrlClickable）+ 长文（parseArticle）
 *               + 媒体画廊（buildMediaTag）
 *   4. 若存在 quote（引用推文），递归渲染引用体及其 article
 *   5. wrapHtml 拼接 <head> + <style>
 *
 * 注意：status.author.name 作为 og:site_name 写进 <head>，
 * 便于消息预览机器人识别"谁在说话"。
 *
 * @param {string} rawPath 原始路径（含 username/status/ 前缀）
 * @param {{lang: string, tz: string}} cfg 时区与翻译语言配置
 * @param {string} waterCss water.css 源码字符串
 * @param {string} twitterCss twitter.css 源码字符串
 * @returns {Promise<string>} 完整的 HTML 页面字符串
 */
async function publish(rawPath, cfg, waterCss, twitterCss) {
  const { lang, tz } = cfg;
  const pid = extractPid(rawPath);
  if (!pid) return "";

  const apiUrl = lang
    ? `https://api.fxtwitter.com/2/thread/${pid}?lang=${encodeURIComponent(lang)}`
    : `https://api.fxtwitter.com/2/thread/${pid}`;
  const resp = await fetch(apiUrl, {
    headers: { Accept: "application/json", "User-Agent": "TelegramBot (like TwitterBot)" },
    signal: AbortSignal.timeout(3000),
    cf: { cacheTtl: 31556952, cacheEverything: true },
  });
  if (!resp.ok) throw new Error(`fxtwitter API ${resp.status}`);
  const data = await resp.json();

  const thisAuthor = data?.status?.author?.name ?? "Anonymous";
  const thread = data?.thread ?? [];

  let fullHtml = "";
  const sorted = thread.slice().sort((a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0));
  for (const post of sorted) {
    const author = post?.author?.name ?? "Anonymous";
    const tweetUrl = post?.url ?? rawPath;
    const dateStr = formatDate(post.created_timestamp, tz);
    const avatarUrl = proxyUrl(post?.author?.avatar_url ?? "");
    const text = (post?.html_no_media ?? post?.translation?.text ?? post?.text ?? "").replace(
      /\n/g,
      "<br>"
    );
    fullHtml += `<hr>${authorTag(author, tweetUrl, dateStr, avatarUrl)}<p>${makeUrlClickable(text)}</p>`;
    if (post.article) fullHtml += parseArticle(post.article, tweetUrl);
    fullHtml += buildMediaTag(post?.media?.all ?? []);

    // 引用推文（quote）递归渲染：article 以标题 + preview_text 摘要形式展示
    if (post.quote) {
      const q = post.quote;
      const qAuthor = q?.author?.name ?? "Anonymous";
      const qUrl = q?.url ?? rawPath;
      const qText = (q?.translation?.text ?? q?.text ?? "").replace(/\n/g, "<br>");
      const qAvatar = proxyUrl(q?.author?.avatar_url ?? "");
      const qDate = formatDate(q.created_timestamp, tz);
      fullHtml += `${authorTag(qAuthor, qUrl, qDate, qAvatar)}<p>${makeUrlClickable(qText)}</p>`;
      if (q.article) {
        const title = q?.article?.title ?? "";
        const preview = q?.article?.preview_text ?? "";
        fullHtml += `<a href="${qUrl}" target="_blank"><h3>《${title}》</h3></a>`;
        fullHtml += `<blockquote>${preview}</blockquote>`;
      }
      fullHtml += buildMediaTag(q?.media?.all ?? []);
    }
  }

  // 清理：删除开头的 <hr> 占位与空段落
  fullHtml = fullHtml.trim().replace(/^<hr>/, "").replace(/<p><\/p>/g, "");
  return wrapHtml(fullHtml, thisAuthor, waterCss, twitterCss);
}

/**
 * 用公共 <head>（water.css + twitter.css）包裹 thread HTML，组装完整页面。
 *
 * 自包含策略：
 *   - 不输出任何外部 <link>/<script> 标签
 *   - 所有 CSS 通过 Text module rule 在本文件导入后注入 <style>
 *   - og:site_name 指示社交平台预览时的站点名
 *
 * @param {string} fullHtml thread 正文 HTML
 * @param {string} thisAuthor 顶层作者的显示名（供 og:site_name 用）
 * @param {string} waterCss water.css 源码字符串
 * @param {string} twitterCss twitter.css 源码字符串
 * @returns {string} 完整自包含的 HTML 文档
 */
export function wrapHtml(fullHtml, thisAuthor, waterCss, twitterCss) {
  return `<!DOCTYPE html>
<html>
<head>
    <meta property="og:site_name" content="X | ${thisAuthor}" />
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
    ${waterCss}
    ${twitterCss}
    </style>
</head>
<body>${fullHtml}</body>
</html>`;
}

/**
 * /<user>/status/<id> 路由的主入口。
 *
 * 拆分 publish 之外的原因：
 *   - 错误处理（API 超时 / JSON 解析失败）集中在此
 *   - 环境变量读取（TIMEZONE / TRANSLATE_TO）留在路由层，
 *     避免污染 publish 的可测试性
 *
 * @param {Request} request 原始请求
 * @param {Object} env Worker 环境变量（含 TIMEZONE / TRANSLATE_TO）
 * @param {string} cleanPath 去首斜杠 + decode 后的路径
 * @param {string} waterCss water.css 源码字符串
 * @param {string} twitterCss twitter.css 源码字符串
 * @returns {Response> 推文 HTML 或错误页面（400/502）
 */
export async function serveTweet(_request, env, cleanPath, waterCss, twitterCss) {
  const cfg = {
    tz: (env && env.TIMEZONE) || "UTC",
    lang: (env && env.TRANSLATE_TO) || "",
  };

  const pid = extractPid(cleanPath);
  // 路径不进 "username/status/123" 格式，直接返回 404
  if (!pid) return new Response("Not found", { status: 404 });

  try {
    const html = await publish(cleanPath, cfg, waterCss, twitterCss);
    if (!html) {
      return new Response("Invalid tweet URL", { status: 400 });
    }
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=31556952",
      },
    });
  } catch (e) {
    return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 502 });
  }
}
