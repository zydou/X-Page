/**
 * lib/bot/matcher.js
 * ============================================================
 * 纯函数：链接识别 + X-Page 链接生成。
 *
 * 只处理 X-Page 实际支持的平台：X/Twitter、GitHub、微信公众号、通用 URL。
 *
 * 本文件不依赖任何 Worker / Telegram 运行时，可独立单元测试。
 * ============================================================
 */

// 通用 URL 的扩展名 → 媒体类型判断
const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp"];
const VIDEO_EXT = [
  ".3gp", ".avi", ".flv", ".m2ts", ".m4v", ".mkv", ".mov", ".mp4",
  ".mpeg", ".mpg", ".mts", ".ogg", ".ogv", ".rmvb", ".webm", ".wmv",
];

// 通用 URL 匹配（与 lib/utils.js makeUrlClickable 同款字符类，
// 自动排除末尾混入的标点：句号、逗号、右括号等）
const URL_RE = /(https?:\/\/[-A-Za-z0-9+&@#/%?=~_|!:,.;]*[-A-Za-z0-9+&@#/%=~_|])/;

/**
 * 从文本中匹配 X-Page 支持的社交平台链接。
 *
 * 返回 `{ platform, ... }`；无匹配时 `{ platform: "" }`。
 * 平台与字段：
 *   - x       → { handle, post_id }
 *   - github  → { gh_user, gh_repo, query }
 *   - wechat  → { url }
 *
 * @param {string} text 任意消息文本
 * @returns {object} 匹配结果
 */
export function matchSocialMediaLink(text) {
  const s = String(text || "");

  // X / Twitter（含 fxtwitter / fixupx / vxtwitter 镜像域名）
  // https://x.com/<handle>/status/<id>
  let m = s.match(/(https?:\/\/)?(:?twitter|x|fxtwitter|fixupx|vxtwitter)\.com\/(\w+)\/status\/(\d+)/);
  if (m) return { platform: "x", handle: m[3], post_id: m[4] };

  // GitHub：github.com/<user>/<repo>[/<subpath>]
  m = s.match(/(https?:\/\/)?github\.com\/([a-zA-Z0-9]+(-[a-zA-Z0-9]+)*)\/([.a-zA-Z0-9_-]+)\/?([.#/a-zA-Z0-9_-]+)?/);
  if (m) return { platform: "github", gh_user: m[2], gh_repo: m[4], query: m[5] || "" };

  // 微信公众号文章：mp.weixin.qq.com/s... （短链 /s/<id> 或 /s?__biz=...）
  // 查询串字符类含 + %：__biz / sn 等参数是 base64，可能出现 + 号与 % 编码
  m = s.match(/(https?:\/\/)?mp\.weixin\.qq\.com\/s[\/?]([_A-Za-z=&0-9#+%-]+)/);
  if (m) return { platform: "wechat", url: m[0] };

  return { platform: "" };
}

/**
 * 提取文本中第一个 http(s) URL（通用链接兜底用）。
 *
 * @param {string} text 任意消息文本
 * @returns {string} 匹配到的 URL；无匹配返回 ""
 */
export function firstHttpUrl(text) {
  const m = String(text || "").match(URL_RE);
  return m ? m[1] : "";
}

/**
 * 依据 URL 扩展名判断媒体类型：image | video | other。
 *
 * @param {string} url 任意 URL
 * @returns {string} "image" | "video" | "other"
 */
export function checkTextType(url) {
  const lower = String(url || "").toLowerCase();
  if (IMAGE_EXT.some((x) => lower.includes(x))) return "image";
  if (VIDEO_EXT.some((x) => lower.includes(x))) return "video";
  return "other";
}

/**
 * 算出回复后需要预热的路由目标（给内部直调预热用，不展示给用户）。
 *
 * 返回数组中每项形如 { kind: "tweet", handle, postId } 或
 * { kind: "wechat", url }，调用方按 kind 分发到对应 handler 的
 * 数据获取入口（见 routes/webhook.js prewarmCache）。
 *
 * 只覆盖会写 R2 的两条路由：
 *   - X/Twitter → 不带 ?mode=/ ?lang= 的推文页（默认即全部推文）
 *   - 微信公众号 → /wechat/<url>
 * 其余平台（GitHub / 通用 URL / 媒体）不落 R2，预热无意义，返回 []。
 *
 * key 说明：推文的 R2 key 只跟 lang 维度有关、与 mode 无关，所以预热默认 URL
 * 一次即可；微信同理，预热存 HTML 的那条 key，Markdown 变体（md/ 前缀）
 * 按需转换时再生成。
 *
 * @param {string} text 消息文本（text 或 caption）
 * @returns {object[]} 预热目标（可能为空数组）
 */
export function buildPrewarmTargets(text) {
  const m = matchSocialMediaLink(text);
  if (m.platform === "x") {
    return [{ kind: "tweet", handle: m.handle, postId: m.post_id }];
  }
  if (m.platform === "wechat") {
    return [{ kind: "wechat", url: m.url }];
  }
  return [];
}

/**
 * 把一条消息文本转换成 X-Page 回复文本。
 *
 * 优先级：X/Twitter → GitHub → 微信公众号 → 通用 URL。
 * 无任何匹配时返回空字符串（调用方静默不回复）。
 *
 * @param {string} text 消息文本（text 或 caption）
 * @param {string} xPageBase X-Page 服务根地址（必填，由调用方从 Secret 读取）
 * @returns {string} 回复文本；无匹配或未配置 X-Page 地址时返回 ""
 */
export function buildReply(text, xPageBase) {
  const base = String(xPageBase || "").replace(/\/+$/, "");
  if (!base) return ""; // 未配置 X-Page 地址 → 不转换

  // X / Twitter → 四种查看模式
  const m = matchSocialMediaLink(text);
  if (m.platform === "x") {
    const u = `${base}/${m.handle}/status/${m.post_id}`;
    return [
      `完整：${u}`,
      `本推：${u}?mode=self`,
      `本推+引用：${u}?mode=quote`,
      `串推：${u}?mode=thread`,
    ].join("\n");
  }

  // GitHub → README / 文件渲染
  if (m.platform === "github") {
    if (m.query.startsWith("releases/")) return ""; // releases 列表页不做转换
    let path = "";
    if (m.query.startsWith("blob/")) {
      // blob/main/README.md → /README.md
      path = "/" + m.query.split("/").slice(2).join("/");
    }
    return `${base}/github/${m.gh_user}/${m.gh_repo}${path}`;
  }

  // 微信公众号 → 文章代理
  if (m.platform === "wechat") {
    return `${base}/wechat/${encodeURIComponent(m.url)}`;
  }

  // 通用 URL 兜底：按扩展名给出转换选项
  const url = firstHttpUrl(text);
  if (!url) return "";
  const enc = encodeURIComponent(url);
  const type = checkTextType(url);
  if (type === "image") {
    return `🏞代理：${base}/img/${enc}\n🏞直链：${base}/img/d/${enc}`;
  }
  if (type === "video") {
    return `🎬代理：${base}/vid/${enc}\n🎬直链：${base}/vid/d/${enc}`;
  }
  return [
    `🎬代理：${base}/vid/${enc}`,
    `🎬直链：${base}/vid/d/${enc}`,
    `🏞代理：${base}/img/${enc}`,
    `🏞直链：${base}/img/d/${enc}`,
    `🌐网页：${base}/html/${enc}`,
    `🌐网页(R2)：${base}/r2-html/${enc}`,
  ].join("\n");
}
