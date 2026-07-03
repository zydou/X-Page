/**
 * Cloudflare Worker: 把 X/Twitter 推文（含 thread / Article）转换为自包含 HTML。
 *
 * 路由（均解析出相同 HTML）
 *   /{username}/status/1794805688696275131
 *   /1794805688696275131
 *   /proxy/<encoded-url>   内部媒体代理，绕过封锁
 *
 */

// 站点样式表：通过 wrangler Text module rule 作为字符串导入（见 wrangler.toml 的 rules），
// 内联进 <style>，彻底去掉外部 <link>，做到 HTML 自包含、不受混合内容拦截。
// water.css 在 GitHub Actions 中被下载到本地 (.github/workflows/deploy.yaml)
import WATER_CSS from "./water.css";
import TWITTER_CSS from "./twitter.css";
const API_TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// 环境变量（wrangler.toml 的 [vars] 节；运行时通过 import.meta.env 读取）
//
//   TIMEZONE        IANA 时区，默认 "UTC"（API 返回的时间戳就是 UTC，默认直接显示）
//   TRANSLATE_TO    翻译目标语言（BCP-47），例如 "zh-cn"；空串去掉 ?lang=，返回原文
// ---------------------------------------------------------------------------

/** 把任意 https URL 转换为内部代理路径，让浏览器通过本 Worker 拉取媒体。 */
function proxyUrl(targetUrl) {
  return `/proxy/` + encodeURIComponent(targetUrl);
}

/**
 * 媒体代理：从路径中取回原始 URL，fetch 并流式返回。
 * 路径格式：/proxy/<encodeURIComponent(originalUrl)>
 * Cloudflare Workers 作为普通的 HTTPS 客户端发出请求，不受地区封锁限制。
 */
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

  // 透传 Range 请求，视频拖拽播放必需
  const headers = {};
  const range = request.headers.get("range");
  if (range) headers.range = range;

  // 不设 signal 超时：大视频回源慢，让平台自身的请求超时兜底（约 100s）。
  // 不启用 cacheEverything：>512MB 的文件无法被 CDN 边缘缓存，显式开启反而干扰流式传输。
  const upstream = await fetch(target, {
    headers,
    cf: {
      cacheTtl: 86400,
    },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream " + upstream.status, { status: upstream.status });
  }

  // 构建响应，保留原始 Content-Type / Content-Length / Content-Range
  const out = new Headers();
  const passThrough = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
    "cache-control",
  ];
  for (const k of passThrough) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has("cache-control")) out.set("cache-control", "public, max-age=86400");
  // CORS 放宽，让 HTML 内 <img>/<video> 跨子域也能正常呈现
  out.set("access-control-allow-origin", "*");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
}

// ---------------------------------------------------------------------------
// 路由解析
// ---------------------------------------------------------------------------

/** 从请求路径中提取推文 ID */
function extractPid(raw) {
  const s = (raw || "").trim();
  // 1. 短格式: /username/status/id
  let m = s.match(/^(\w+)\/status\/(\d+)$/);
  if (m) return m[2];
  // 2. 纯 ID
  m = s.match(/^(\d+)$/);
  if (m) return m[1];
  return null;
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
// 主流程
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

function indexHtml(host) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>X → HTML</title></head><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 16px">
<h2>将 X/Twitter 推文转换为HTML</h2>
<p>支持以下两种格式（等价）：</p>
<ul>
    <li>https://${host}/\${username}/status/\${post_id}</li>
    <li>https://${host}/\${post_id}</li>
</ul>
<h4>示例</h4>
<p>原始：<a href="https://x.com/SpaceX/status/2072464558732824680">https://<mark>x.com</mark>/SpaceX/status/2072464558732824680</a></p>
<p>转换：<a href="https://${host}/SpaceX/status/2072464558732824680">https://<mark>${host}</mark>/SpaceX/status/2072464558732824680</a></p>
<p>或者：<a href="https://${host}/2072464558732824680">https://<mark>${host}</mark>/<del>SpaceX/status/</del>2072464558732824680</a></p>
<hr>
<h2>Convert X/Twitter to HTML</h2>
<p>Supports the following two formats (equivalent):</p>
<ul>
    <li>https://${host}/\${username}/status/\${post_id}</li>
    <li>https://${host}/\${post_id}</li>
</ul>
<h4>Example</h4>
<p>Original: <a href="https://x.com/SpaceX/status/2072464558732824680">https://<mark>x.com</mark>/SpaceX/status/2072464558732824680</a></p>
<p>Converted: <a href="https://${host}/SpaceX/status/2072464558732824680">https://<mark>${host}</mark>/SpaceX/status/2072464558732824680</a></p>
<p>Or: <a href="https://${host}/2072464558732824680">https://<mark>${host}</mark>/<del>SpaceX/status/</del>2072464558732824680</a></p>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Worker 入口
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const u = new URL(request.url);
    let path = u.pathname.replace(/^\//, "");
    try {
      path = decodeURIComponent(path);
    } catch (e) {
      /* 已 decode 或非法编码，原样使用 */
    }

    if (!path || path === "favicon.ico") {
      return new Response(indexHtml(u.host), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // 媒体代理路由：/proxy/<encodeURIComponent(url)>
    if (path === "proxy" || path.startsWith("proxy/")) {
      return handleProxy(request);
    }

    const cfg = {
      tz: (env && env.TIMEZONE) || "UTC",
      lang: (env && env.TRANSLATE_TO) || "",
    };

    try {
      const html = await publish(path, cfg);
      if (!html) {
        return new Response("Invalid tweet URL", { status: 400 });
      }
      return new Response(html, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "public, max-age=300",
        },
      });
    } catch (e) {
      return new Response("Error: " + (e && e.message ? e.message : String(e)), { status: 502 });
    }
  },
};
