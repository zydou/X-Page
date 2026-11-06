/**
 * routes/webhook.js
 * ============================================================
 * Telegram Bot webhook 路由：POST /webhook
 *
 * Telegram 把每条更新 POST 到 setWebhook 指定的 URL；若设置了
 * secret_token，则在请求头 X-Telegram-Bot-Api-Secret-Token 携带。
 * 本路由校验该头，不一致返回 403（fail-closed）。
 *
 * 设计要点：
 *   - webhook 立即返回 200，实际处理放进 ctx.waitUntil，
 *     避免 Telegram 因响应慢而重复投递（重复投递会让 bot 反复回复）。
 *   - 链接转换是纯字符串拼接（零网络），媒体下载 + 图床上传是唯一的网络重活。
 *   - 白名单（ALLOWED_CHATS）配置 chat 或 chat:thread 组合，
 *     支持指定群话题 + 指定用户私聊。
 * ============================================================
 */

import { buildReply, buildPrewarmTargets } from "../lib/bot/matcher.js";
import { sendMessage, sendChatAction } from "../lib/bot/telegram.js";
import { mediaTypeOf, handleMedia } from "../lib/bot/media.js";
import { prewarmTweet } from "./tweet.js";
import { prewarmWechat } from "./wechat.js";

const HELP = `X-Page 转换机器人
──────────────
发送以下内容自动转换：
• X / Twitter 链接 → 完整 / 本推 / 串推
• GitHub 链接 → README / 文件渲染
• 微信公众号链接 → 文章代理
• 图片 / 视频 → X-Page 预览
• 任意 URL → 代理 / 直链 / 网页`;

/**
 * 处理 POST /webhook（Telegram bot 入口）。
 *
 * @param {Request} request 入站请求
 * @param {object} env 绑定环境（vars + secrets）
 * @param {object} ctx ExecutionContext
 * @returns {Response}
 */
/**
 * webhook 内部直接调用路由 handler 预热 R2：触发真实回源并写 R2，
 * 让用户点开转换链接时直接命中缓存，无需首次等待。
 *
 * 内部直调而非 GET 自家域名：自 fetch 自定义域名容易撞 Cloudflare
 * 边缘缓存层 522（wrangler tail 实测 `prewarm 失败: HTTP 522`），
 * 直接调 handler 则完全走 Worker 内部链路、不经边缘。
 *
 * 逐个执行、忽略失败（上游超时 / R2 写失败）：缓存只是优化，
 * 预热失败下次真实请求仍会正常回源，绝不影响已发送的回复。
 *
 * @param {object[]} targets buildPrewarmTargets 算出的目标
 * @param {object} env Worker 环境
 * @param {object} ctx Worker ExecutionContext（透传给 handler 做后台写回）
 */
async function prewarmCache(targets, env, ctx) {
  // 推文预热按 PREWARM_LANGS 分发：默认回退 TRANSLATE_TO；配置为 "cn,ja" 即两份都写。
  const prewarmLangs = String((env && env.PREWARM_LANGS) || "").split(",").map((s) => s.trim()).filter(Boolean);
  const effectiveLangs = prewarmLangs.length ? prewarmLangs : [undefined]; // undefined → prewarmTweet 走 TRANSLATE_TO
  for (const t of targets) {
    try {
      const r = t.kind === "tweet"
        ? await Promise.all(effectiveLangs.map((lang) => prewarmTweet(t.postId, env, ctx, lang)))
        : await prewarmWechat(t.url, env, ctx);
      if (!r) throw new Error("prewarm returned empty");
    } catch (err) {
      // 预热失败只记日志，不重试、不通知用户
      console.error("prewarm 失败:", JSON.stringify(t), err?.message || err);
    }
  }
}

export async function handleWebhook(request, env, ctx) {
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  // 校验 webhook secret（setWebhook 时配置的 secret_token）
  const got = request.headers.get("x-telegram-bot-api-secret-token");
  if (!env.WEBHOOK_SECRET || got !== env.WEBHOOK_SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  const update = await request.json();
  ctx.waitUntil(handleUpdate(update, env, ctx));
  return new Response("ok");
}

/**
 * 处理一条 webhook update。
 *
 * @param {object} update Telegram Update
 * @param {object} env Worker 环境对象
 */
async function handleUpdate(update, env, ctx) {
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

    // 回复已发送后，内部直调预热写 R2（见 prewarmCache）。
    // 不在 ctx.waitUntil 里：handleUpdate 本身已跑在 webhook 的 waitUntil 中，
    // 内部直调不经网络层，不会撞 522；单进程内串行等就是全部代价。
    const targets = reply ? buildPrewarmTargets(text) : [];
    if (targets.length) await prewarmCache(targets, env, ctx);
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
