/**
 * lib/bot/telegram.js
 * ============================================================
 * Telegram Bot API 客户端（fetch 封装）。
 *
 * 所有方法都走 https://api.telegram.org/bot<token>/<method>，
 * 成功时返回响应的 `result` 字段；失败抛出 Error（含 Telegram 返回的 description）。
 * ============================================================
 */

/** Bot API 根地址（token 只应存在 Worker Secret 中，切勿暴露到客户端）。 */
export function apiBase(env) {
  return `https://api.telegram.org/bot${env.BOT_TOKEN}`;
}

/**
 * 调用任意 Bot API 方法。
 *
 * @param {object} env Worker 环境对象（需含 BOT_TOKEN）
 * @param {string} method 方法名，如 "sendMessage"
 * @param {object} [body] 请求体
 * @returns {Promise<any>} Telegram 返回的 result
 */
export async function api(env, method, body) {
  const res = await fetch(`${apiBase(env)}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) {
    const desc = j.description || `HTTP ${res.status}`;
    throw new Error(`telegram ${method} failed: ${desc}`);
  }
  return j.result;
}

/**
 * 发送文本消息，作为对 msg 的回复（自动继承消息线程）。
 *
 * 刻意不设 parse_mode —— 纯文本模式下 Telegram 会自动把裸 URL
 * 变成可点击链接，这正是多行链接回复想要的呈现效果。
 * link_preview_options 关闭预览：一条回复带 2~6 个链接时预览是噪音。
 *
 * @param {object} env Worker 环境对象
 * @param {object} msg 触发的 Message（提供 chat.id / message_id / message_thread_id）
 * @param {string} text 回复文本
 * @returns {Promise<any>} sendMessage 的 result
 */
export function sendMessage(env, msg, text) {
  const body = {
    chat_id: msg.chat.id,
    text,
    reply_parameters: { message_id: msg.message_id },
    link_preview_options: { is_disabled: true },
  };
  if (msg.message_thread_id) body.message_thread_id = msg.message_thread_id;
  return api(env, "sendMessage", body);
}

/**
 * 发送"正在输入"类动作（typing / upload_photo / upload_video / ...）。
 *
 * @param {object} env Worker 环境对象
 * @param {number|string} chatId 目标 chat id
 * @param {string} action 动作名，如 "typing"
 * @param {number} [threadId] forum 话题 id（可选）
 * @returns {Promise<any>} sendChatAction 的 result
 */
export function sendChatAction(env, chatId, action, threadId) {
  const body = { chat_id: chatId, action };
  if (threadId) body.message_thread_id = threadId;
  return api(env, "sendChatAction", body);
}

/**
 * 获取文件信息（file_path / file_size / file_unique_id）。
 *
 * @param {object} env Worker 环境对象
 * @param {string} fileId 文件的 file_id
 * @returns {Promise<{file_id: string, file_unique_id?: string, file_size?: number, file_path?: string}>}
 */
export function getFile(env, fileId) {
  return api(env, "getFile", { file_id: fileId });
}

/**
 * 构造文件下载 URL。
 * 注意：该 URL 内嵌 BOT_TOKEN，只能在 Worker 服务端使用，切勿下发客户端。
 *
 * @param {object} env Worker 环境对象
 * @param {string} filePath getFile 返回的 file_path
 * @returns {string} 下载 URL
 */
export function fileUrl(env, filePath) {
  return `${apiBase(env)}/file/${filePath}`;
}
