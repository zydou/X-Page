/**
 * bot/media.js
 * ============================================================
 * 媒体处理：Telegram 照片 / 视频 / 文档 → 下载 → 图床上传 → X-Page 链接。
 *
 * 策略：
 *   - 图片：先 Imgur，失败回退 ImgBB
 *   - 视频：只走 Imgur（ImgBB 仅收图片）
 *
 * 上传成功拿到公网 URL 后，回复 X-Page /img/ 或 /vid/ 链接指向该图床地址。
 * 媒体不落 R2 —— 容量交给图床，本 Worker 无状态。
 * ============================================================
 */

import { getFile, fileUrl, sendMessage } from "./telegram.js";

// Bot API 单次可下载的最大文件大小（Telegram 官方硬限制，20MB）
const MAX_FILE_SIZE = 20 * 1024 * 1024;

/**
 * 判定消息中的媒体类型。
 *
 * @param {object} msg Telegram Message
 * @returns {string|null} "image" | "video" | null（非媒体）
 */
export function mediaTypeOf(msg) {
  if (msg.photo) return "image";
  if (msg.video) return "video";
  if (msg.document) {
    const mime = msg.document.mime_type || "";
    if (mime.startsWith("image/")) return "image";
    if (mime.startsWith("video/")) return "video";
  }
  return null;
}

/** 从消息中取出媒体的 file_id / mime。 */
function pickFile(msg, type) {
  if (type === "image" && msg.photo) {
    // 照片有多档尺寸，数组按尺寸升序，最后一个最大
    const largest = msg.photo[msg.photo.length - 1];
    return { fileId: largest.file_id, mime: "image/jpeg" };
  }
  if (type === "video" && msg.video) {
    return { fileId: msg.video.file_id, mime: msg.video.mime_type || "video/mp4" };
  }
  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      mime: msg.document.mime_type || "application/octet-stream",
    };
  }
  return null;
}

/** mime → 文件扩展名（图床靠扩展名识别类型）。 */
function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m === "image/jpeg" || m === "image/jpg") return ".jpg";
  if (m === "image/png") return ".png";
  if (m === "image/gif") return ".gif";
  if (m === "image/webp") return ".webp";
  if (m === "video/mp4") return ".mp4";
  if (m === "video/webm") return ".webm";
  if (m === "video/quicktime") return ".mov";
  return "";
}

/**
 * 把二进制编码为 base64（ImgBB 要求）。
 * 分块 String.fromCharCode，避免大数组展开撑爆调用栈。
 */
function toBase64(bytes) {
  let bin = "";
  const CHUNK = 0x8000; // 32768
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** 上传到 Imgur，返回直链；失败返回 ""（由调用方决定回退）。 */
async function uploadImgur(env, bytes, mime) {
  if (!env.IMGUR_CLIENTID) return "";
  const ext = extFromMime(mime) || ".jpg";
  const form = new FormData();
  form.append("type", "file");
  form.append("image", new Blob([bytes], { type: mime }), `media${ext}`);
  const res = await fetch("https://api.imgur.com/3/image", {
    method: "POST",
    headers: { Authorization: `Client-ID ${env.IMGUR_CLIENTID}` },
    body: form,
  });
  const j = await res.json().catch(() => ({}));
  if (!j.success || !j.data?.link) {
    console.error("imgur 上传失败:", j.data?.error || `HTTP ${res.status}`);
    return "";
  }
  return j.data.link;
}

/** 上传到 ImgBB（base64），返回直链；失败返回 ""。 */
async function uploadImgbb(env, bytes, mime) {
  if (!env.IMGBB_API_KEY) return "";
  const b64 = toBase64(bytes);
  const res = await fetch("https://api.imgbb.com/1/upload", {
    method: "POST",
    body: new URLSearchParams({ key: env.IMGBB_API_KEY, image: b64 }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.success || !j.data?.url) {
    console.error("imgbb 上传失败:", j.data?.error || `HTTP ${res.status}`);
    return "";
  }
  return j.data.url;
}

/**
 * 处理媒体消息：下载 → 图床上传 → 回复 X-Page 链接。
 *
 * 失败时发送友好错误（内部消化异常，不向上抛，避免 waitUntil 静默失败）。
 *
 * @param {object} msg Telegram Message
 * @param {object} env Worker 环境对象（BOT_TOKEN + IMGUR_CLIENTID / IMGBB_API_KEY）
 * @param {string} xPageBase X-Page 服务根地址
 * @param {string} type 媒体类型 "image" | "video"
 */
export async function handleMedia(msg, env, xPageBase, type) {
  const picked = pickFile(msg, type);
  if (!picked) return;
  // X-Page 地址必须由调用方传入（来自 Secret X_PAGE_BASE），无兜底
  const base = String(xPageBase || "").replace(/\/+$/, "");
  if (!base) throw new Error("X_PAGE_BASE 未配置");

  const f = await getFile(env, picked.fileId);
  if (!f.file_path) throw new Error("telegram 未返回 file_path");

  // 超过 Bot API 下载上限 → 提前拒绝，避免白等一个必然失败的请求
  if (f.file_size && f.file_size > MAX_FILE_SIZE) {
    await sendMessage(env, msg, "⚠️ 文件超过 20MB，Telegram Bot API 无法下载，请改用链接。");
    return;
  }

  // 下载（全量缓冲：图床上传需要完整字节）
  const dl = await fetch(fileUrl(env, f.file_path));
  if (!dl.ok) throw new Error(`下载失败：HTTP ${dl.status}`);
  const bytes = new Uint8Array(await dl.arrayBuffer());

  // 图片：Imgur → ImgBB 回退；视频：仅 Imgur
  let url = "";
  if (type === "image") {
    url = await uploadImgur(env, bytes, picked.mime);
    if (!url) url = await uploadImgbb(env, bytes, picked.mime);
  } else {
    url = await uploadImgur(env, bytes, picked.mime);
  }
  if (!url) throw new Error("图床上传失败");

  const enc = encodeURIComponent(url);
  const text =
    type === "image"
      ? `🏞 X-Page：${base}/img/${enc}`
      : `🎬 X-Page：${base}/vid/${enc}`;
  await sendMessage(env, msg, text);
}
