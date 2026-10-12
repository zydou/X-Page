/**
 * routes/tweet.js
 * ============================================================
 * X / Twitter 推文 → 自包含 HTML 的主路由。
 *
 * 路由形态：/<username>/status/<tweet_id>[?mode=<mode>][&lang=<lang>][&refresh]
 *
 * 解析模式（?mode=，缺省 = all，非法值同样回退 all）：
 *   all    fxtwitter 返回的完整 thread（含本推的祖先推文）+ 每条的引用，历史默认行为
 *   self   仅本推
 *   quote  本推 + 本推引用
 *   thread 本推 + 本推的串推后代（剔除祖先推文）
 *
 * 翻译语言（?lang=）：
 *   - 查询参数优先于 TRANSLATE_TO 环境变量；两者都缺省时不翻译
 *   - lang 原样透传给 fxtwitter（/2/thread/<id>?lang=<lang>），返回的
 *     translation 字段按该语言给出译文
 *   - R2 key 带语言维度（tweet/<id>.<lang>.json）：不同 lang 的译文不同，
 *     必须各存一份，否则 ?lang=ja 会命中 ?lang=zh-cn 的缓存
 *
 * 完整渲染流水线：
 *   1. parseMode() / parseLang()  从 query 提取解析模式与翻译语言
 *   2. extractPid()               从路径提取推文 ID
 *   3. fetchTweetData()           取 thread 数据（R2 命中 → 回源 fxtwitter 并写回 R2）
 *   4. threadDescendants()        从 thread 中筛出本推的串推后代（剔除祖先）
 *   5. renderPost()               单条推文 → HTML（头部 + 正文 + article + 媒体 + 引用）
 *   6. wrapHtml()                 用 water.css + twitter.css 包裹生成最终页
 *
 * 资产注入：
 *   - waterCss / twitterCss 由 worker.js 通过参数注入
 *   - proxyUrl 等工具函数来自 lib/utils.js
 *
 * 文件较大（约 300 行），但逻辑上是单一推事的"内部流水线"：
 * 一个入口的产出是下一个阶段的输入，拆分反而增加跳转成本。
 * ============================================================
 */

import {
  extractPid,
  formatDate,
  estimateTokens,
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

/** ?mode= 的合法取值 */
const MODES = ["all", "self", "quote", "thread"];

/**
 * 解析 ?mode= 查询参数。
 *
 * 只接受 all / self / quote / thread；缺省或任何非法值一律回退 all，
 * 不做 400——分享出去的链接带上未知参数时不应炸掉整个页面。
 *
 * @param {string|null} raw URL 上的原始 mode 值
 * @returns {"all"|"self"|"quote"|"thread"} 规范化后的解析模式
 */
function parseMode(raw) {
  return MODES.includes(raw) ? raw : "all";
}

/** lang 的形状：BCP-47 语言标签（ja / zh-cn / pt-BR 等） */
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z]{2,8})?$/;

/**
 * 解析 ?lang= 查询参数。
 *
 * 只接受 BCP-47 形态的语言标签；缺省或任何非法值返回空串（由调用方
 * 回退到 TRANSLATE_TO 环境变量），不做 400——与 parseMode 同理。
 * 做形状校验是因为 lang 会拼进 R2 key，
 * 不能让它把路径分隔符等字符带进 key。
 *
 * @param {string|null} raw URL 上的原始 lang 值
 * @returns {string} 规范化后的语言标签，无翻译时为空串
 */
function parseLang(raw) {
  if (typeof raw !== "string" || !raw) return "";
  return LANG_RE.test(raw) ? raw : "";
}

/**
 * 从 fxtwitter 的 data.thread 中筛出"本推的串推后代"。
 *
 * thread[] 不只包含后代，还可能包含本推的祖先推文（实测：请求回复推文时
 * thread 里同样带父推文）。祖先集通过从本推沿 replying_to.status 向上游走
 * 得到，遍历限定在 thread[] 的 id 集合内，循环上限 thread.length 次防环。
 *
 * @param {string} pid 请求的推文 ID
 * @param {Array} thread fxtwitter 返回的 data.thread
 * @returns {Array} 按 created_timestamp 升序排列的后代推文
 */
function threadDescendants(pid, thread) {
  thread = thread || [];
  const ids = new Set(thread.map((p) => p && p.id));
  const ancestors = new Set();
  let cur = thread.find((p) => p && p.id === pid);
  for (let i = 0; i < thread.length && cur; i++) {
    const parent = cur.replying_to && cur.replying_to.status;
    if (!parent || !ids.has(parent)) break;
    ancestors.add(parent);
    cur = thread.find((p) => p && p.id === parent);
  }
  return thread
    .filter((p) => p && p.id && p.id !== pid && !ancestors.has(p.id))
    .sort((a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0));
}

/**
 * 渲染单条推文为 HTML 片段：头部 + 正文 + 长文 + 媒体画廊 + 可选引用。
 *
 * 本推、串推、引用推文共用同一套渲染逻辑。此前主循环与 quote 块是两段
 * 重复代码且字段访问不一致（quote 漏了 html_no_media），抽出后统一为
 * html_no_media ?? translation.text ?? text。
 *
 * article 的呈现按上下文区分（保留历史行为）：
 *   - 正文推文 → parseArticle 全量渲染
 *   - 引用推文 → 仅标题《…》+ preview_text 摘要，避免长文撑爆页面
 *
 * @param {Object|null} post fxtwitter 返回的单条推文对象
 * @param {{url: string, tz: string, refreshUrl: string}} opt 渲染上下文：url = 无 url 字段时的回退链接，tz = 时区，refreshUrl = 刷新按钮链接
 * @param {boolean} [opt.withQuote] 是否展开该推的引用推文（仅展开一层）
 * @param {boolean} [opt.articlePreview] 以"标题+摘要"而非全量渲染 article
 * @returns {string} 可直接嵌入推文卡片的 HTML 片段
 */
function renderPost(post, opt) {
  if (!post) return "";
  const { url: fallbackUrl, tz, refreshUrl, withQuote = false, articlePreview = false } = opt;
  const author = post.author && post.author.name ? post.author.name : "Anonymous";
  const tweetUrl = post.url || fallbackUrl;
  const avatarUrl = proxyUrl(post.author && post.author.avatar_url ? post.author.avatar_url : "");
  const text = (post.html_no_media ?? post.translation?.text ?? post.text ?? "").replace(/\n/g, "<br>");

  let html = authorTag(author, tweetUrl, formatDate(post.created_timestamp, tz), avatarUrl, refreshUrl);
  html += `<p>${makeUrlClickable(text)}</p>`;
  if (post.article) {
    if (articlePreview) {
      // 引用推文只给标题 + 摘要
      const title = post.article.title ?? "";
      const preview = post.article.preview_text ?? "";
      html += `<a href="${tweetUrl}" target="_blank"><h3>《${title}》</h3></a><blockquote>${preview}</blockquote>`;
    } else {
      html += parseArticle(post.article, tweetUrl);
    }
  }
  html += buildMediaTag(post.media && post.media.all ? post.media.all : []);

  if (withQuote && post.quote) {
    html += renderPost(post.quote, { url: fallbackUrl, tz, refreshUrl, articlePreview: true });
  }
  return html;
}

/**
 * 把 fxtwitter 数据拼成整页 thread HTML（纯渲染，不做任何 I/O）。
 *
 * 数据获取在 fetchTweetData() 完成：HTML 与 Markdown 两条输出路径
 * 共用同一份数据，缓存与回源逻辑只有一份。
 *
 * 渲染顺序：
 *   1. all 模式：完整 thread 按 created_timestamp 升序渲染（thread 不一定有序），
 *      每条推文都展开引用——与旧实现逐字节一致，含本推的祖先推文
 *   2. 其他模式以本推为起点：self 只渲染本推；quote 追加本推引用；
 *      thread 追加 threadDescendants() 筛出的串推后代（剔除祖先推文）
 *   3. wrapHtml 拼接 <head> + <style>
 *
 * 注意：status.author.name 作为 og:site_name 写进 <head>，
 * 便于消息预览机器人识别"谁在说话"。
 *
 * @param {Object|null} data fxtwitter thread 对象（fetchTweetData 返回值）
 * @param {{tz: string}} cfg 时区配置
 * @param {"all"|"self"|"quote"|"thread"} mode 解析模式（见文件头）
 * @param {string} waterCss water.css 源码字符串
 * @param {string} twitterCss twitter.css 源码字符串
 * @param {string} rawPath 原始路径（含 username/status/ 前缀），供缺 url 的推文做回退链接
 * @param {string} [refreshUrl] 刷新按钮的链接 URL
 * @returns {{html: string, empty: boolean}} HTML + body 是否为空
 */
function renderHtml(data, cfg, mode, waterCss, twitterCss, rawPath, refreshUrl) {
  const { tz } = cfg;
  const pid = extractPid(rawPath);

  const thisAuthor = data?.status?.author?.name ?? "Anonymous";
  const base = { url: rawPath, tz, refreshUrl };
  const thread = data?.thread ?? [];
  const byTs = (a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0);

  let fullHtml;
  if (mode === "all") {
    // 历史默认行为：渲染 fxtwitter 返回的完整 thread（含本推的祖先推文），
    // 按时间升序，且每条推文的引用都展开。这里刻意不复用 threadDescendants，
    // 以保证 ?mode=all 与不带参数的输出与旧实现逐字节一致。
    const ids = new Set(thread.filter((p) => p && p.id).map((p) => p.id));
    const list = (ids.has(pid) ? thread : [data?.status, ...thread]).filter((p) => p && p.id);
    fullHtml = list
      .sort(byTs)
      .map((p, i) => (i ? `<hr>` : "") + renderPost(p, { ...base, withQuote: true }))
      .join("");
  } else {
    // self / quote / thread 均以本推为起点
    fullHtml = renderPost(data?.status, { ...base, withQuote: mode === "quote" });
    // thread 模式追加串推后代（剔除本推的祖先推文）
    if (mode === "thread") {
      for (const post of threadDescendants(pid, thread)) {
        fullHtml += `<hr>` + renderPost(post, { ...base });
      }
    }
  }

  // 清理空段落
  fullHtml = fullHtml.trim().replace(/<p><\/p>/g, "");
  // empty 标记：body 无任何内容时禁止边缘缓存，避免瞬时异常渲染被缓存整整一年
  return { html: wrapHtml(fullHtml, thisAuthor, waterCss, twitterCss), empty: fullHtml.length === 0 };
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
 * @param {string} twitterCss twitterCss 源码字符串
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
 * 将单条推文渲染为 Markdown 片段。
 * 复用 renderPost 的数据提取逻辑，仅改输出格式。
 */
function renderPostMarkdown(post, opt) {
  if (!post) return "";
  const { tz, refreshUrl, withQuote = false, articlePreview = false, isQuote = false } = opt;
  const author = post.author && post.author.name ? post.author.name : "Anonymous";
  const tweetUrl = post.url || opt.url || "";
  const avatarUrl = post.author && post.author.avatar_url ? post.author.avatar_url : "";
  // 取纯文本（优先 translation.text > text > html_no_media 去标签）
  let text = post.translation?.text ?? post.text ?? post.html_no_media ?? "";
  text = text.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");

  // YAML frontmatter：结构化元数据，便于 Agent 解析
  const dateStr = formatDate(post.created_timestamp, tz);
  const fmAuthor = author.replace(/"/g, '\\"');
  const fmTweetUrl = tweetUrl.replace(/"/g, '\\"');
  let md = `---\nauthor: "${fmAuthor}"\nauthor_url: "${fmTweetUrl}"\ndate: "${dateStr}"\ntweet_url: "${fmTweetUrl}"`;
  if (isQuote) md += `\ntweet_type: "quote"`;
  md += `\n---\n\n`;
  md += text + "\n";

  if (post.article) {
    if (articlePreview) {
      const title = post.article.title ?? "";
      const preview = post.article.preview_text ?? "";
      md += `\n**[${title}](${tweetUrl})**\n\n${preview}\n`;
    } else {
      // article 完整渲染：标题 + blocks
      md += `\n## [${post.article.title || "Twitter Article"}](${tweetUrl})\n`;
      for (const block of post.article.content?.blocks ?? []) {
        const blockText = inlineStyle(block.text, block.inlineStyleRanges)
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "");
        switch (block.type) {
          case "header-one":
          case "header-two":
            md += `\n## ${blockText}\n`;
            break;
          case "header-three":
            md += `\n### ${blockText}\n`;
            break;
          case "header-four":
            md += `\n#### ${blockText}\n`;
            break;
          case "blockquote":
            md += `\n> ${blockText}\n`;
            break;
          case "ordered-list-item":
          case "unordered-list-item":
            md += `\n- ${blockText}`;
            break;
          case "atomic":
            md += `\n${parseAtomicMarkdown(block.entityRanges, post.article)}\n`;
            break;
          default:
            if (blockText.trim()) md += `\n${blockText}\n`;
        }
      }
      const coverUrl = post.article.cover_media?.media_info?.original_img_url ?? "";
      if (coverUrl) md += `\n![cover](${coverUrl})\n`;
    }
  }

  // 媒体
  const mediaAll = post.media?.all ?? [];
  for (const m of mediaAll) {
    if (m.type === "photo" && m.url) {
      md += `\n![image](${m.url})\n`;
    } else if (m.type === "video" && m.url) {
      md += `\n[video](${m.url})\n`;
    } else if (m.type === "gif" && m.url) {
      md += `\n[gif](${m.url})\n`;
    }
  }

  if (withQuote && post.quote) {
    md += renderPostMarkdown(post.quote, { ...opt, articlePreview: true, isQuote: true });
  }
  return md;
}

/**
 * 解析 article atomic 块为 markdown（简化版，复用 entityMap 逻辑）。
 */
function parseAtomicMarkdown(entities, article) {
  if (!entities || !entities.length) return "";
  // 收拢 article 内的静态媒体
  const mediaList = [];
  for (const media of article?.media_entities || []) {
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
  const entityMap = article?.content?.entityMap ?? {};
  const entityDict = {};
  if (Array.isArray(entityMap)) {
    for (const x of entityMap) entityDict[String(x.key)] = x.value;
  } else {
    for (const k in entityMap) entityDict[String(k)] = entityMap[k];
  }

  let texts = "";
  for (const x of entities) {
    const entity = entityDict[String(x.key)];
    if (!entity) continue;
    const eType = (entity.type || "").toUpperCase();
    if (eType === "MEDIA") {
      const mediaId = entity?.data?.mediaItems?.[0]?.mediaId ?? "";
      const photo = mediaList.find((m) => m.type === "photo" && m.media_id === mediaId);
      if (photo) texts += `\n![image](${photo.url})\n`;
      else {
        const vid = mediaList.find((m) => m.type === "video" && m.media_id === mediaId);
        if (vid) texts += `\n[video](${vid.url})\n`;
      }
    } else if (eType === "DIVIDER") {
      texts += "\n---\n";
    } else if (eType === "TWEET") {
      const tweetId = entity?.data?.tweetId ?? "";
      if (tweetId) texts += `\n> [Quote Tweet](https://x.com/i/status/${tweetId})\n`;
    } else if (eType === "MARKDOWN") {
      const markdown = (entity?.data?.markdown ?? "").replace(/`/g, "");
      const idx = markdown.indexOf("\n");
      if (idx >= 0) {
        const lang = markdown.slice(0, idx);
        const raw = markdown.slice(idx + 1);
        texts += `\n\`\`\`${lang}\n${raw}\n\`\`\`\n`;
      } else {
        texts += `\n\`\`\`\n${markdown}\n\`\`\`\n`;
      }
    }
  }
  return texts.trim();
}

/**
 * 将 fxtwitter 完整数据渲染为完整 Markdown 文档。
 * 与 renderHtml() 保持同一套逻辑（mode 过滤、排序、引用展开等）。
 */
function renderMarkdown(data, cfg, mode, refreshUrl, pid) {
  const { tz } = cfg;
  const thread = data?.thread ?? [];
  const byTs = (a, b) => (a.created_timestamp || 0) - (b.created_timestamp || 0);
  const base = { tz, refreshUrl };

  let md = "";
  if (mode === "all") {
    const ids = new Set(thread.filter((p) => p && p.id).map((p) => p.id));
    const list = (ids.has(pid) ? thread : [data?.status, ...thread]).filter((p) => p && p.id);
    md = list
      .sort(byTs)
      .map((p) => renderPostMarkdown(p, { ...base, withQuote: true }))
      .join("\n");
  } else {
    md = renderPostMarkdown(data?.status, { ...base, withQuote: mode === "quote" });
    if (mode === "thread") {
      for (const post of threadDescendants(pid, thread)) {
        md += "\n" + renderPostMarkdown(post, base);
      }
    }
  }
  return md.trim();
}

/**
 * /<user>/status/<id> 路由的主入口。
 *
 * 数据获取（fetchTweetData）与渲染（renderHtml / renderMarkdown）分离，
 * 本函数只做三件事：
 *   - 解析 query 参数（mode / lang / refresh）与环境变量，拼出 cfg 与 refreshUrl
 *   - 错误处理（API 超时 / JSON 解析失败）集中在此
 *   - 支持 Accept: text/markdown 协商，返回纯 Markdown（供 Agent / CLI 直接消费）
 *
 * @param {Request} request 原始请求
 * @param {Object} env Worker 环境变量（含 TIMEZONE / TRANSLATE_TO）
 * @param {string} cleanPath 去首斜杠 + decode 后的路径
 * @param {string} waterCss water.css 源码字符串
 * @param {string} twitterCss twitter.css 源码字符串
 * @returns {Response} 推文 HTML 或 Markdown，或错误页面（400/404/502）
 */
export async function serveTweet(request, env, cleanPath, waterCss, twitterCss, ctx) {
  const url = new URL(request.url);
  const refresh = url.searchParams.has("refresh");
  const mode = parseMode(url.searchParams.get("mode"));
  // ?lang= 优先于 TRANSLATE_TO 环境变量；两者都缺省时不翻译
  const lang = parseLang(url.searchParams.get("lang")) || (env && env.TRANSLATE_TO) || "";
  // 刷新链接需带上 mode 与 lang，否则点刷新按钮会跳回默认参数
  const refreshUrl = `/${cleanPath}?refresh=1`
    + (mode === "all" ? "" : `&mode=${mode}`)
    + (lang ? `&lang=${lang}` : "");
  const cfg = {
    tz: (env && env.TIMEZONE) || "UTC",
    lang,
  };

  const pid = extractPid(cleanPath);
  // 路径不进 "username/status/123" 格式，直接返回 404
  if (!pid) return new Response("Not found", { status: 404 });

  // 检查是否请求 Markdown（Agent / CLI 协商）
  const accept = request.headers.get("accept") || "";
  const wantsMarkdown = accept.includes("text/markdown");

  try {
    // HTML 与 Markdown 共用同一次数据获取（R2 命中 → 回源 fxtwitter 并写回 R2）
    const { data, fallback } = await fetchTweetData(cleanPath, cfg, refresh, env, ctx);

    if (wantsMarkdown) {
      if (!data || !data.status) {
        return new Response("Tweet not found", { status: 404 });
      }
      const md = renderMarkdown(data, cfg, mode, refreshUrl, pid);
      if (!md) {
        return new Response("Empty tweet", { status: 404 });
      }
      const headers = {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": refresh ? "public, max-age=0" : "public, max-age=31556952",
        "vary": "Accept",
        "x-markdown-tokens": String(estimateTokens(md)),
      };
      return new Response(md, { headers });
    }

    // 默认 HTML 模式
    if (!data) return new Response("Invalid tweet URL", { status: 400 });
    const { html, empty } = renderHtml(data, cfg, mode, waterCss, twitterCss, cleanPath, refreshUrl);

    // 空页面（body 无内容）不缓存：瞬时空响应一旦被边缘缓存会顶住整整一年
    const headers = {
      "content-type": "text/html; charset=utf-8",
      "cache-control": empty ? "no-store" : refresh ? "public, max-age=0" : "public, max-age=31556952",
      "vary": "Accept",
    };
    if (fallback) {
      headers["x-cache-fallback"] = "r2";
    }

    return new Response(html, { headers });
  } catch (e) {
    return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 502 });
  }
}

/**
 * 获取 fxtwitter thread 数据（不做渲染）。
 * HTML 与 Markdown 两条输出路径共用它，回源与缓存逻辑只有一份实现。
 *
 * fxtwitter API：
 *   - /2/thread/<id>         返回 { status, thread[] }
 *   - /2/thread/<id>?lang=X  额外返回 translation 字段（按 X 翻译的译文）
 *
 * 缓存策略：
 *   - R2 持久层，key 带语言维度：`tweet/<id>.<lang>.json`（无翻译时 `tweet/<id>.json`）
 *     不同 lang 的译文不同，必须各存一份，否则请求 A 语言会命中 B 语言的缓存
 *   - 命中规则：R2 有对象就用 R2，没有任何"应用层过期"判断
 *   - 唯一会回源的触发：用户主动点击 ?refresh=1（页面刷新按钮）
 *   - R2 兜底清理：lifecycle 规则在 365 天后删除（见 wrangler R2 配置）
 *
 * @param {string} rawPath 原始路径（含 username/status/ 前缀）
 * @param {{lang: string}} cfg 翻译语言配置
 * @param {boolean} [refresh] 是否强制刷新（绕过 R2，强制调 API）
 * @param {Object} [env] Worker 环境（含 R2 绑定 TWEETS）
 * @param {Object} [ctx] Worker ExecutionContext（用于 waitUntil 后台回写）
 * @returns {Promise<{data: Object|null, fallback: boolean}>} 推文数据；fallback = 是否回退到了 R2 旧数据
 */
async function fetchTweetData(rawPath, cfg, refresh, env, ctx) {
  const { lang } = cfg;
  const pid = extractPid(rawPath);
  if (!pid) return { data: null, fallback: false };

  // R2 key 带上语言维度：同一推文的 ja / zh-cn 译文各不相同
  const r2Key = lang ? `tweet/${pid}.${lang}.json` : `tweet/${pid}.json`;

  let data = null;
  // 记录 R2 兜底数据，仅在 refresh 模式 + fxtwitter 失败时使用
  let fallbackFromR2 = null;
  let fallback = false;

  // 第一步：尝试 R2
  // - 非 refresh 模式：命中就用
  // - refresh 模式：先记下来备用，fxtwitter 失败时回退
  if (env?.TWEETS) {
    const obj = await env.TWEETS.get(r2Key);
    if (obj) {
      try {
        const parsed = JSON.parse(await obj.text());
        if (refresh) fallbackFromR2 = parsed;
        else data = parsed;
      } catch {
        // 损坏的 JSON 忽略
      }
    }
  }

  // 第二步：data 未拿到 → 拉 fxtwitter 并写回 R2
  if (!data) {
    let apiUrl = lang
      ? `https://api.fxtwitter.com/2/thread/${pid}?lang=${lang}`
      : `https://api.fxtwitter.com/2/thread/${pid}`;
    if (refresh) apiUrl += `${lang ? "&" : "?"}_t=${Date.now()}`;
    let resp;
    try {
      resp = await fetch(apiUrl, {
        headers: { Accept: "application/json", "User-Agent": "TelegramBot (like TwitterBot)" },
        signal: AbortSignal.timeout(3000),
        cf: refresh
          ? { cacheTtl: 0, cacheEverything: true }
          : { cacheTtl: 31556952, cacheEverything: true },
      });
    } catch (e) {
      // 网络层失败（超时、DNS、TLS 等）：refresh 模式下回退到 R2
      if (!fallbackFromR2) throw e;
      data = fallbackFromR2;
      fallback = true;
    }
    if (!data) {
      if (!resp.ok) {
        // HTTP 4xx/5xx：refresh 模式下回退到 R2
        if (!fallbackFromR2) throw new Error(`fxtwitter API ${resp.status}`);
        data = fallbackFromR2;
        fallback = true;
      } else {
        data = await resp.json();
        // 异步写回 R2（不阻塞响应）；thread 为空说明是瞬时空响应，不写缓存以免污染一年
        if (env?.TWEETS && ctx && (data?.thread?.length ?? 0) > 0) {
          ctx.waitUntil(
            env.TWEETS.put(r2Key, JSON.stringify(data), {
              httpMetadata: { contentType: "application/json" },
            }).catch(() => {
              // R2 写失败不影响本次响应，下次请求会重新拉
            })
          );
        }
      }
    }
  }
  return { data, fallback };
}
