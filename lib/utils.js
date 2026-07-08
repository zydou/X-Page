/**
 * lib/utils.js
 * ============================================================
 * 跨路由复用的纯函数工具库。
 *
 * 本文件只包含不依赖任何 Worker 内联资产（CSS / Artplayer JS）
 * 的通用函数，因此可以被 video / image / proxy / tweet 任意
 * 路由安全地导入，不存在循环引用风险。
 *
 * 函数清单：
 *   - proxyUrl            任意 https URL → 内部 /proxy/ 路径
 *   - extractPid          从 "username/status/123" 中提取推文 ID
 *   - tsToDate            秒级时间戳 → Date
 *   - formatDate          时间戳 + 时区 → "YYYY-MM-DD HH:mm:ss TZ"
 *   - makeUrlClickable    纯文本中的裸 URL → <a> 链接
 *   - authorTag           推文作者区的 HTML 片段
 *   - parseMedia          统一的媒体列表归一化（photo/gif/video → {url, type, w, h}）
 *   - buildMediaTag       从 parseMedia 结果生成 <div class="media-gallery">
 * ============================================================
 */

/**
 * 把任意 https(s) URL 包装为本 Worker 的内部代理路径。
 *
 * 浏览器拿到的始终是 https://<host>/proxy/<encoded> 形式，
 * 由 /proxy/ 路由统一做 Range 透传、长缓存、CORS 与
 * Content-Disposition 修正，对上层路由完全透明。
 *
 * @param {string} targetUrl 原始媒体 URL，例如 "https://example.com/vid.mp4"
 * @returns {string} 内部代理路径，例如 "/proxy/https%3A%2F%2Fexample.com%2Fvid.mp4"
 */
export function proxyUrl(targetUrl) {
  return "/proxy/" + encodeURIComponent(targetUrl);
}

/**
 * 从请求路径中提取推文 ID。
 *
 * 只识别 "username/status/123456" 形态：
 *   - username  允许字母 / 数字 / 下划线（Twitter 用户名的合法字符集）
 *   - status    固定字面量
 *   - 尾部必须为纯数字的推文 ID
 *
 * @param {string} raw 去首斜杠后的路径，例如 "SpaceX/status/2072464558732824680"
 * @returns {string|null} 提取到的推文 ID；不匹配时返回 null
 */
export function extractPid(raw) {
  const s = (raw || "").trim();
  const m = s.match(/^(\w+)\/status\/(\d+)$/);
  return m ? m[2] : null;
}

/**
 * 把秒级 UNIX 时间戳转为 Date 对象。
 *
 * 对非法输入（非数字 / NaN）安全地回退到当前时间，
 * 避免 Intl.DateTimeFormat 抛出异常、污染整个页面渲染。
 *
 * @param {number} ts 秒级时间戳（推文 API 字段 created_timestamp 即此格式）
 * @returns {Date} 对应时刻的 Date 对象；解析失败时为 `new Date()`
 */
export function tsToDate(ts) {
  if (typeof ts !== "number" || isNaN(ts)) return new Date();
  return new Date(ts * 1000);
}

/**
 * 把时间戳格式化为 "YYYY-MM-DD HH:mm:ss <tz>" 字符串。
 *
 * 使用 Intl.DateTimeFormat("en-GB") 而不是 toLocaleString：
 *   - en-GB 的格式顺序天然接近 ISO（年/月/日 时:分:秒）
 *   - 显式 timeZone 选项让输出不受 Worker 运行时区影响
 *   - hour12: false 保证 24 小时制
 *
 * formatToParts 拆出每个单位后手动拼接，避免浏览器对分隔符的差异。
 *
 * @param {number} ts 秒级时间戳
 * @param {string} tz IANA 时区名，例如 "Asia/Shanghai"、"UTC"
 * @returns {string} 形如 "2026-07-07 14:30:00 Asia/Shanghai"
 */
export function formatDate(ts, tz) {
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

  // 收集各 part 的值，例如 { year: "2026", month: "07", day: "07", ... }
  const parts = {};
  for (const { type, value } of fmt.formatToParts(d)) parts[type] = value;

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${tz}`;
}

/**
 * 把文本中所有裸 URL（未包在 HTML 属性或标签内的 http(s)://…）
 * 替换为可点击的 <a target="_blank"> 链接。
 *
 * 注意：本函数在推文正文渲染管线里位于 HTML 已经拼好之后，
 * 因此不做 HTML 实体转义——上游 fxtwitter API 返回的已是
 * 转义后的文本，这里只负责匹配 URL 模式并包壳。
 *
 * 正则采用一个较宽泛的字符类 `[ -~]` 子集：
 *   允许：字母 / 数字 / 常见 URL 符号（-._:/?#@!*,;）及连接符
 *   截尾：排除容易混入标点符号的最后一个字符（如句号、右括号），
 *         减少把末尾逗号闭合括号吃进链接的概率
 *
 * @param {string} text 推文正文或其他纯文本
 * @returns {string} URL 被 <a> 标签包裹后可安全嵌入 HTML 的文本
 */
export function makeUrlClickable(text) {
  const urlPattern = /(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|])/g;
  return text.replace(urlPattern, '<a href="$1" target="_blank">$1</a>');
}

/**
 * 生成推文头部片段：头像 + 作者名 + 发布时间。
 *
 * 头像连接到推文原文（target="_blank"），方便用户在不离开当前
 * 页面上下文的情况下跳回 X/Twitter 查看详情。
 *
 * 语义结构（供 twitter.css 选择器用）：
 *   div.tweet-header
 *     a → img.tweet-avatar
 *     div.tweet-info
 *       div.tweet-author > a
 *       div.tweet-time
 *
 * @param {string} author 显示名（data.status.author.name）
 * @param {string} tweetUrl 推文原文 URL（data.url）
 * @param {string} dateStr 由 formatDate 渲染后的时间字符串
 * @param {string} avatarUrl 头像 URL（已包装为内部 /proxy/ 路径）
 * @returns {string} 可直接嵌入推文卡片的 HTML 片段
 */
export function authorTag(author, tweetUrl, dateStr, avatarUrl) {
  return `<div class="tweet-header">
    <a href="${tweetUrl}" target="_blank"><img src="${avatarUrl}" class="tweet-avatar"></a>
    <div class="tweet-info">
        <div class="tweet-author"><a href="${tweetUrl}" target="_blank">${author}</a></div>
        <div class="tweet-time">${dateStr}</div>
    </div>
</div>`;
}

/**
 * 把 fxtwitter API 返回的媒体列表归一化为统一结构。
 *
 * 输入：data.media.all 数组，每项至少含 { type, url, width, height }；
 *       video / gif 额外含 formats[]（多码率 mp4 列表）。
 *
 * 输出：每项为 { url, type, width, height }，其中：
 *   - photo → type: "image"，url 取原始图片 URL
 *   - gif   → type: "video"，url 取最高码率的 h264 mp4
 *   - video → type: "video"，url 取最高码率的 h264 mp4
 *
 * 为什么只取 h264：浏览器原生 <video> 对 h264 支持最广泛，
 * 不需要 Worker 端做转码，直接喂给播放器即可。
 *
 * @param {Array<{type: string, url?: string, width?: number, height?: number, formats?: Array}>} mediaList
 * @returns {Array<{url: string, type: string, width: number, height: number}>}
 */
export function parseMedia(mediaList) {
  const media = [];
  for (const x of mediaList) {
    if (x.type === "photo") {
      media.push({
        url: x.url,
        type: "image",
        width: x.width || 0,
        height: x.height || 0,
      });
    } else if (x.type === "gif" || x.type === "video") {
      // 多码率中挑 h264 最高码率，保证清晰度与兼容性平衡
      const mp4 = (x.formats || []).filter((f) => f.codec === "h264");
      mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      const mp4Url = mp4[0] ? mp4[0].url || "" : "";
      media.push({
        url: mp4Url,
        type: "video",
        width: x.width || 0,
        height: x.height || 0,
      });
    }
  }
  return media;
}

/**
 * 从归一化后的媒体列表生成 <div class="media-gallery"> 片段。
 *
 * 布局规则：
 *   - 视频：<video controls class="tweet-media [landscape]">
 *   - 图片：<a target="_blank"><img loading="lazy" class="tweet-media"></a>
 *   - 横宽图（width > height）给 <a> 加 class="landscape"，由 CSS 控制最大宽度
 *
 * 所有媒体 URL 都经过 proxyUrl() 包装，强制走内部代理：
 *   既解决防盗链 / 跨域，又让 Cloudflare 缓存命中。
 *
 * 空画廊（没有任何可识别媒体）时返回空字符串，避免输出一个
 * 无内容的 <div class="media-gallery"></div> 占位。
 *
 * @param {Array} mediaAll fxtwitter API 的 data.media.all 原始数组
 * @returns {string} 可直接嵌入推文卡片的 HTML 片段，或空字符串
 */
export function buildMediaTag(mediaAll) {
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
