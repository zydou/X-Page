/**
 * bot/matcher.js
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
  ].join("\n");
}
