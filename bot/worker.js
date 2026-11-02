/**
 * bot/worker.js
 * ============================================================
 * X-Page 转换 Telegram Bot（Cloudflare Worker 入口）。
 *
 * 路由：
 *   POST /webhook   Telegram webhook（校验 secret_token，处理更新）
 *   GET  /           健康检查 / 用法说明
 *
 * 设计要点：
 *   - webhook 立即返回 200，实际处理放进 ctx.waitUntil，
 *     避免 Telegram 因响应慢而重复投递（重复投递会让 bot 反复回复）。
 *   - 链接转换是纯字符串拼接（零网络），媒体下载 + 图床上传是唯一的网络重活。
 *   - 白名单（ALLOWED_CHATS）配置 `chat` 或 `chat:thread` 组合，
 *     支持指定群话题 + 指定用户私聊。
 * ============================================================
 */

import { buildReply } from "./matcher.js";
import { sendMessage, sendChatAction } from "./telegram.js";
import { mediaTypeOf, handleMedia } from "./media.js";

const HELP = `X-Page 转换机器人
──────────────
发送以下内容自动转换：
• X / Twitter 链接 → 完整 / 本推 / 串推
• GitHub 链接 → README / 文件渲染
• 微信公众号链接 → 文章代理
• 图片 / 视频 → X-Page 预览
• 任意 URL → 代理 / 直链 / 网页`;

export default {
  /**
   * Worker 主入口。
   *
   * @param {Request} request 入站请求
   * @param {object} env 绑定环境（vars + secrets）
   * @param {object} ctx ExecutionContext
   * @returns {Response}
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Telegram webhook
    if (url.pathname === "/webhook") {
      if (request.method !== "POST") {
        return new Response("method not allowed", { status: 405 });
      }
      // 校验 webhook secret（setWebhook 时配置的 secret_token）
      const got = request.headers.get("x-telegram-bot-api-secret-token");
      if (!env.WEBHOOK_SECRET || got !== env.WEBHOOK_SECRET) {
        return new Response("forbidden", { status: 403 });
      }
      const update = await request.json();
      ctx.waitUntil(handleUpdate(update, env));
      return new Response("ok");
    }

    // 健康检查 / 用法
    return new Response(HELP, {
      status: 200,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};

/**
 * 处理一条 webhook update。
 *
 * @param {object} update Telegram Update
 * @param {object} env Worker 环境对象
 */
async function handleUpdate(update, env) {
  const msg = update.message;
  if (!msg) return;

  try {
    // 白名单：未配置时响应所有来源；配置时仅允许列表内的 (chat, thread) 组合
    if (!isAllowed(msg, env.ALLOWED_CHATS)) return;

    const text = msg.text || msg.caption || "";

    // X-Page 地址必须来自 Secret（X_PAGE_BASE），无兜底 —— 缺失即拒绝转换
    const xPageBase = (env.X_PAGE_BASE || "").trim();
    if (!xPageBase) {
      console.error("X_PAGE_BASE 未配置：wrangler secret put X_PAGE_BASE");
      await sendMessage(env, msg, "⚠️ 机器人未配置 X_PAGE_BASE，无法转换。");
      return;
    }

    // 命令
    if (/^\/(start|help)\b/i.test(text.trim())) {
      await sendChatAction(env, msg.chat.id, "typing", msg.message_thread_id);
      await sendMessage(env, msg, HELP);
      return;
    }

    // 媒体消息 → 下载并转 X-Page 链接
    const mtype = mediaTypeOf(msg);
    if (mtype) {
      const action = mtype === "image" ? "upload_photo" : "upload_video";
      await sendChatAction(env, msg.chat.id, action, msg.message_thread_id);
      await handleMedia(msg, env, xPageBase, mtype);
      return;
    }

    // 文本 / 纯链接 → 链接转换
    await sendChatAction(env, msg.chat.id, "typing", msg.message_thread_id);
    const reply = buildReply(text, xPageBase);
    if (reply) await sendMessage(env, msg, reply);
  } catch (err) {
    // 记录错误并尽力告知用户，但不让 waitUntil 静默吞掉
    console.error("handleUpdate error:", err?.message || err);
    try {
      await sendMessage(env, msg, `⚠️ 处理失败：${err?.message || "未知错误"}`);
    } catch {
      /* 通知失败则不再处理 */
    }
  }
}

/**
 * 白名单判定。
 *
 * ALLOWED_CHATS 格式：逗号分隔，每项 `<chatId>` 或 `<chatId>:<threadId>`。
 *   - `<chatId>`           匹配该 chat 的任何 thread（私聊 chat.id = 用户 id，无 thread）
 *   - `<chatId>:<threadId>` 同时匹配指定 forum 话题
 * 空字符串 / 未配置 → 允许所有来源。
 *
 * @param {object} msg Telegram Message
 * @param {string} allowed ALLOWED_CHATS 配置值
 * @returns {boolean} 是否允许处理该消息
 */
function isAllowed(msg, allowed) {
  const raw = String(allowed || "").trim();
  if (!raw) return true;

  const chatId = String(msg.chat.id);
  const threadId = msg.message_thread_id != null ? String(msg.message_thread_id) : "";

  return raw.split(",").some((rule) => {
    const r = rule.trim();
    if (!r) return false;
    const [cid, tid] = r.split(":");
    if (cid !== chatId) return false;
    // 无 thread 限制的规则匹配任何 thread（含私聊无 topic 的情况）
    if (tid === undefined || tid === "") return true;
    return tid === threadId;
  });
}
