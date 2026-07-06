/**
 * Unified service Worker: Twitter-to-HTML, video proxy, image proxy, and generic media proxy behind one hostname.
 *
 * 路由：
 *   /vid/<encodeURIComponent(url)>          内部视频代理 → Artplayer HTML
 *   /vid/d/<encodeURIComponent(url)>        直连视频，不经过代理
 *   /img/<encodeURIComponent(url)>          内部图片代理 → 自适应 HTML
 *   /img/d/<encodeURIComponent(url)>        直连图片，不经过代理
 *   /proxy/<encodeURIComponent(url)>        通用媒体代理（透传 + 长缓存）
 *   /<username>/status/<tweet_id>           X/Twitter 推文 → 自包含 HTML
 *   /                                      使用说明页
 *
 * 所有渲染出的 HTML 均完全自包含（无外部 <link>/<script>）：
 *   - Third-party JS (Artplayer) is fetched by CI as artplayer.js, serialized via JSON.stringify
 *     into a `export default "..."` ES module (artplayer.mjs), and inlined as a string value.
 *   - water.css / twitter.css 通过 Wrangler Text module rule 以字符串导入。
 */
// 内联CSS：通过 wrangler Text module rule 作为字符串导入（见 wrangler.toml 的 rules）。
// 内联JS：CI 通过 JSON.stringify 把 artplayer.js 源码打包成 artplayer.mjs 的 export default 字符串，
// Wrangler 以 ESM 形式导入后直接在模板字符串里做值替换。
// 最终拼出的 HTML 完全自包含，无外部 <link>/<script> 引用。
import ARTPLAYER_JS from "./artplayer.mjs";
import WATER_CSS from "./water.css";
import TWITTER_CSS from "./twitter.css";
const API_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// 工具：把任意 https URL 转换为内部代理路径，让浏览器通过本 Worker 拉取媒体。
// ---------------------------------------------------------------------------

function proxyUrl(targetUrl) {
  return "/proxy/" + encodeURIComponent(targetUrl);
}

// ---------------------------------------------------------------------------
// 通用媒体代理 —— 视频 / 图片 / 推文内媒体复用同一实现
// 路径格式：/proxy/<encodeURIComponent(originalUrl)>
// Cloudflare Workers 作为普通的 HTTPS 客户端发出请求，不受地区封锁限制。
// ---------------------------------------------------------------------------

async function handleProxy(request) {
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
  if (!/^https?:\/\//i.test(target)) {
    return new Response("only http(s) urls are allowed", { status: 400 });
  }

  // 透传 Range 请求头，视频拖拽播放必需
  const headers = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;

  // 不设 signal 超时：大视频回源慢，让平台自身的请求超时兜底（约 100s）。
  const upstream = await fetch(target, {
    headers,
    cf: {
      cacheTtl: 31556952, // 1 年
      cacheEverything: true,
    },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, { status: upstream.status });
  }

  // 构建响应，保留原始 Content-Type / Content-Length / Content-Range
  // cache-control 不放透传：强制写死 1 年 + immutable。这些 URL 基于
  // hash、永不改变，浏览器在有效期内连条件请求（If-None-Match）都不发。
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
  // CORS 放宽，让 HTML 内 <img>/<video> 跨子域也能正常呈现
  out.set("access-control-allow-origin", "*");
  out.set("content-disposition", "inline"); // 强制 inline，覆盖上游 attachment

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

// ---------------------------------------------------------------------------
// 视频服务
// ---------------------------------------------------------------------------

function isDirectVideo(cleanPath) {
  return (
    cleanPath === "vid/d" ||
    cleanPath.startsWith("vid/d/")
  );
}

async function serveVideo(request, cleanPath, host) {
  const isDirect = isDirectVideo(cleanPath);
  let encodedUrl;
  if (isDirect) {
    encodedUrl = cleanPath.slice("vid/d/".length);
  } else {
    encodedUrl = cleanPath.slice("vid/".length);
  }

  if (!encodedUrl) {
    return new Response(videoIndexHtml(host), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let rawUrl = encodedUrl;
  try {
    rawUrl = decodeURIComponent(encodedUrl);
  } catch (e) { /* keep encoded */ }

  if (!/^https?:\/\//i.test(rawUrl)) {
    return new Response(
      "无效的链接格式。请确保传入的是以 http 或 https 开头（或 URL 编码后）的视频直链",
      { status: 400 }
    );
  }

  // 决定最终喂给播放器的 URL
  let playerUrl = rawUrl;
  if (!isDirect) {
    playerUrl = proxyUrl(rawUrl);
  }

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
${ARTPLAYER_JS}
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

function videoIndexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><title>ArtPlayer</title></head><body style=\"font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 16px\">
  <h2>ArtPlayer Worker</h2>
  <ul>
      <li><strong>视频代理</strong>：通过 Worker 代理视频流，绕过大多数视频站的防盗链/跨域限制</li>
      <li><strong>长缓存</strong>：利用 Cloudflare CDN 缓存视频 1 年，加速二次加载</li>
      <li><strong>直链模式</strong>：<code>/vid/d/&lt;url&gt;</code> 路径可直接播放不经过代理的视频</li>
  </ul>
  <h3>使用方法</h3>
  <h4>代理模式（默认）</h4>
  <p>https://${host}/vid/<mark>&lt;VIDEO_URL&gt;</mark>（最好是URL编码后的形式）</p>
  <p>例如：（以下两者等效）</p>
  <ul>
      <li><a href="https://${host}/vid/https%3A%2F%2Fsamplelib.com%2Fmp4%2Fsample-5s.mp4">https://${host}/vid/https%3A%2F%2Fsamplelib.com%2Fmp4%2Fsample-5s.mp4</a></li>
      <li><a href="https://${host}/vid/https://samplelib.com/mp4/sample-5s.mp4">https://${host}/vid/https://samplelib.com/mp4/sample-5s.mp4</a></li>
  </ul>
  <p>视频会被 Worker 代理加载，绕过站的反爬限制。</p>
  <h4>直连模式</h4>
  <p>https://${host}/vid/d/<mark>&lt;VIDEO_URL&gt;</mark>（最好是URL编码后的形式）</p>
  <p>绕过 Worker 代理，直接使用视频原始链接播放（适用于没有限制的场景）。</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// 图片服务
// ---------------------------------------------------------------------------

async function serveImage(request, cleanPath, host) {
  const isDirect =
    cleanPath === "img/d" ||
    cleanPath.startsWith("img/d/");

  let encodedUrl;
  if (isDirect) {
    encodedUrl = cleanPath.slice("img/d/".length);
  } else {
    encodedUrl = cleanPath.slice("img/".length);
  }

  if (!encodedUrl) {
    return new Response(imageIndexHtml(host), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  let rawUrl = encodedUrl;
  try {
    rawUrl = decodeURIComponent(encodedUrl);
  } catch (e) { /* keep encoded */ }

  if (!/^https?:\/\//i.test(rawUrl)) {
    return new Response(
      "无效的链接格式。请确保传入的是以 http 或 https 开头（或 URL 编码后）的图片直链",
      { status: 400 }
    );
  }

  let imageUrl = rawUrl;
  if (!isDirect) {
    imageUrl = proxyUrl(rawUrl);
  }

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

function imageIndexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Image Proxy</title></head><body style="font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 16px">
  <h2>基于 CF Worker 的图片代理</h2>
  <p>主要应用在飞书云文档中用于内嵌图片链接，以<strong>预览视图</strong>进行展示</p>
  <ul>
      <li><strong>剥离 download</strong>：自动去除上游的 <code>Content-Disposition: attachment</code>，让浏览器始终以内联方式显示图片</li>
      <li><strong>自适应缩放</strong>：页面 CSS 让图片按原始比例完整展示，不会出现"只看到左上角"的问题</li>
      <li><strong>长缓存</strong>：利用 Cloudflare CDN 缓存图片 1 年，加速二次加载</li>
      <li><strong>直链模式</strong>：<code>/img/d/&lt;url&gt;</code> 路径可直接显示不经过代理的图片</li>
  </ul>
  <h3>使用方法</h3>
  <h4>代理模式（默认）</h4>
  <p>https://${host}/img/<mark>&lt;IMAGE_URL&gt;</mark>（最好是URL编码后的形式）</p>
  <h4>直连模式</h4>
  <p>https://${host}/img/d/<mark>&lt;IMAGE_URL&gt;</mark>（最好是URL编码后的形式）</p>
  <p>绕过 Worker 代理，直接显示图片原始链接（适用于没有 Content-Disposition 限制的场景）。</p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// 路由解析 —— 推文
// ---------------------------------------------------------------------------

// 从请求路径中提取推文 ID，形式: username/status/id
function extractPid(raw) {
  const s = (raw || "").trim();
  const m = s.match(/^(\w+)\/status\/(\d+)$/);
  return m ? m[2] : null;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function tsToDate(ts) {
  if (typeof ts !== "number" || isNaN(ts)) return new Date();
  return new Date(ts * 1000);
}

function formatDate(ts, tz) {
  const d = tsToDate(ts);
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = {};
  for (const { type, value } of fmt.formatToParts(d)) parts[type] = value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${tz}`;
}

function makeUrlClickable(text) {
  const urlPattern = /(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|])/g;
  return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}

function authorTag(author, tweetUrl, dateStr, avatarUrl) {
  return `<div class="tweet-header">
    <a href="${tweetUrl}" target="_blank"><img src="${avatarUrl}" class="tweet-avatar"></a>
    <div class="tweet-info">
        <div class="tweet-author"><a href="${tweetUrl}" target="_blank">${author}</a></div>
        <div class="tweet-time">${dateStr}</div>
    </div>
</div>`;
}

// ---------------------------------------------------------------------------
// 媒体
// ---------------------------------------------------------------------------

function parseMedia(mediaList) {
  const media = [];
  for (const x of mediaList) {
    if (x.type === "photo") {
      media.push({ url: x.url, type: "image", width: x.width || 0, height: x.height || 0 });
    } else if (x.type === "gif" || x.type === "video") {
      const mp4 = (x.formats || []).filter((f) => f.codec === "h264");
      mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const mp4Url = mp4[0] ? mp4[0].url || "" : "";
      media.push({ url: mp4Url, type: "video", width: x.width || 0, height: x.height || 0 });
    }
  }
  return media;
}

function buildMediaTag(mediaAll) {
  let tag = '<div class="media-gallery">';
  for (const item of parseMedia(mediaAll || [])) {
    const landscape = item.width > item.height;
    if (item.type === "video") {
      const cls = landscape ? "tweet-media landscape" : "tweet-media";
      tag += `<video src="${proxyUrl(item.url)}" controls class="${cls}"></video>`;
    } else if (item.type === "image") {
      const landscapeClass = landscape ? ' class="landscape"' : "";
      tag += `<a href="${proxyUrl(item.url)}" target="_blank"${landscapeClass}><img src="${proxyUrl(item.url)}" loading="lazy" class="tweet-media"></a>`;
    }
  }
  tag += "</div>";
  return tag === '<div class="media-gallery"></div>' ? "" : tag;
}

// ---------------------------------------------------------------------------
// Twitter Article
// ---------------------------------------------------------------------------

function parseArticle(article, tweetUrl) {
  function inlineStyle(text, styles) {
    if (typeof text !== "string" || !text.trim()) return "";
    styles = styles || [];
    const n = text.length;
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

  let html = "";
  const coverUrl = article?.cover_media?.media_info?.original_img_url ?? "";
  if (coverUrl) html += `\n<img src="${proxyUrl(coverUrl)}" loading="lazy" />`;

  // 收集 article 内的媒体
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

// ---------------------------------------------------------------------------
// 推文主流程
// ---------------------------------------------------------------------------

async function publish(rawPath, cfg) {
  const { lang, tz } = cfg;
  const pid = extractPid(rawPath);
  if (!pid) return "";

  const apiUrl = lang
    ? `https://api.fxtwitter.com/2/thread/${pid}?lang=${encodeURIComponent(lang)}`
    : `https://api.fxtwitter.com/2/thread/${pid}`;
  const resp = await fetch(apiUrl, {
    headers: { Accept: "application/json", "User-Agent": "TelegramBot (like TwitterBot)" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
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
    const text = (post?.html_no_media ?? post?.translation?.text ?? post?.text ?? "").replace(/\n/g, "<br>");
    fullHtml += `<hr>${authorTag(author, tweetUrl, dateStr, avatarUrl)}<p>${makeUrlClickable(text)}</p>`;
    if (post.article) fullHtml += parseArticle(post.article, tweetUrl);
    fullHtml += buildMediaTag(post?.media?.all ?? []);

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

  // 去掉开头 <hr> -> 删除空段落
  fullHtml = fullHtml.trim().replace(/^<hr>/, "").replace(/<p><\/p>/g, "");
  return wrapHtml(fullHtml, thisAuthor);
}

function wrapHtml(fullHtml, thisAuthor) {
  return `<!DOCTYPE html>
<html>
<head>
    <meta property="og:site_name" content="X | ${thisAuthor}" />
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
    ${WATER_CSS}
    ${TWITTER_CSS}
    </style>
</head>
<body>${fullHtml}</body>
</html>`;
}

// ---------------------------------------------------------------------------
// 使用说明页
// ---------------------------------------------------------------------------

function indexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>X-Page</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px">
<h2>X-Page Worker</h2>

<h3>🐦 X / Twitter 推文 → HTML</h3>
<p><code>https://${host}/&lt;username&gt;/status/&lt;tweet_id&gt;</code></p>
<ul>
  <li>支持推文、Thread、Article；自动展开链接</li>
  <li>内置媒体代理，无需外部代理即可在受限地区访问推内图片/视频</li>
</ul>
<p>示例：</p>
<p>原始：<a href="https://x.com/SpaceX/status/2072464558732824680">https://<mark>x.com</mark>/SpaceX/status/2072464558732824680</a></p>
<p>转换：<a href="https://${host}/SpaceX/status/2072464558732824680">https://<mark>${host}</mark>/SpaceX/status/2072464558732824680</a></p>

<h3>🎬 视频代理</h3>
<p><code>https://${host}/vid/&lt;VIDEO_URL&gt;</code></p>
<ul>
  <li>通过 Worker 代理视频流，绕过防盗链与跨域限制</li>
  <li>1 年 CDN 缓存；完整透传 <code>Range</code> 请求头，支持拖拽播放</li>
</ul>
<p>直连模式：<code>https://${host}/vid/d/&lt;VIDEO_URL&gt;</code>（不经代理）</p>
<p>示例：<code>https://${host}/vid/https%3A%2F%2Fsamplelib.com%2Fmp4%2Fsample-5s.mp4</code></p>

<h3>🖼️ 图片代理</h3>
<p><code>https://${host}/img/&lt;IMAGE_URL&gt;</code></p>
<ul>
  <li>剥离 <code>Content-Disposition: attachment</code>，强制以 <code>inline</code> 显示</li>
  <li>自适应缩放，支持飞书云文档等 16:9 预览窗格内完整查看</li>
  <li>1 年 CDN 缓存</li>
</ul>
<p>直连模式：<code>https://${host}/img/d/&lt;IMAGE_URL&gt;</code>（不经代理）</p>

<h3>🔗 通用媒体代理</h3>
<p><code>https://${host}/proxy/&lt;URL&gt;</code></p>
<p>直接透传任意 <code>http(s)://</code> 资源，附带 CORS、长缓存。</p>

<hr>
<h2>X-Page Worker</h2>

<h3>🐦 X / Twitter → HTML</h3>
<p><code>https://${host}/&lt;username&gt;/status/&lt;tweet_id&gt;</code></p>

<h3>🎬 Video Proxy</h3>
<p><code>https://${host}/vid/&lt;VIDEO_URL&gt;</code></p>
<p>Direct: <code>https://${host}/vid/d/&lt;VIDEO_URL&gt;</code></p>

<h3>🖼️ Image Adaptive Proxy</h3>
<p><code>https://${host}/img/&lt;IMAGE_URL&gt;</code></p>
<p>Direct: <code>https://${host}/img/d/&lt;IMAGE_URL&gt;</code></p>

<h3>🔗 Generic Media Proxy</h3>
<p><code>https://${host}/proxy/&lt;URL&gt;</code></p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    let cleanPath = u.pathname.replace(/^\//, "");
    try {
      cleanPath = decodeURIComponent(cleanPath);
    } catch (e) { /* keep raw */ }

    // 根路径 → 使用说明
    if (!cleanPath || cleanPath === "favicon.ico") {
      return new Response(indexHtml(u.host), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // 视频路由
    if (cleanPath === "vid" || cleanPath.startsWith("vid/")) {
      return serveVideo(request, cleanPath, u.host);
    }

    // 图片路由
    if (cleanPath === "img" || cleanPath.startsWith("img/")) {
      return serveImage(request, cleanPath, u.host);
    }

    // 通用媒体代理
    if (cleanPath === "proxy" || cleanPath.startsWith("proxy/")) {
      return handleProxy(request);
    }

    // 推文路由（兜底）
    const cfg = {
      tz: (env && env.TIMEZONE) || "UTC",
      lang: (env && env.TRANSLATE_TO) || "",
    };

    const pid = extractPid(cleanPath);
    if (pid) {
      try {
        const html = await publish(cleanPath, cfg);
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

    return new Response("Not found", { status: 404 });
  },
};
