/**
 * lib/to-markdown.js
 * ============================================================
 * HTML → Markdown 转换层（基于 Workers AI `toMarkdown`）。
 *
 * 注意与 lib/markdown.js 的区别：那个是 markdown → HTML（给 /github/
 * 渲染 README 用），本模块是反方向，且依赖 Workers AI 绑定。
 *
 * 为什么用 Workers AI 而不是 Browser Run（2026-10 从 Browser Run 迁过来）：
 *
 *   Browser Run 的 /markdown quick action 在免费套餐下的配额是 1 次/10 秒
 *   外加浏览器时间 10 分钟/天。后者是硬墙，速率再高也救不了——逼着旧实现
 *   必须把每次转换结果永久落 R2，并在 Worker 内做 25 秒的 429 退避重试。
 *
 *   `toMarkdown` 对 HTML 是纯确定性解析（剥离 script/style、抽 meta、
 *   解析相对链接），不调用任何模型，因此消耗 0 Neuron，完全不碰免费套餐
 *   10,000 Neurons/天 的池子。实测（2026-10，本账号）：
 *     - 只有「单独上传图片文件」才走 detr-resnet-50 + gemma 烧 Neuron；
 *       HTML 里嵌着的 <img> 只变成链接，不触发视觉模型。X-Page 的管线
 *       只传 HTML 字符串，所以始终走零 Neuron 路径。
 *     - Worker 内的 env.AI.toMarkdown() 绑定在免费套餐上可用（实测验证）。
 *     - 3.54 MiB 微信文档 3.3 秒转出 13,301 字符，逐字节确定性。
 *   所以旧实现里为配额设计的退避逻辑和绝对化补丁都可以删掉。
 *
 * 免费套餐约束（决定本模块必须被 R2 缓存包住）：
 *   转换本身零配额，但单篇 130-330ms、实测约 8% 的请求有 48-100 秒长尾。
 *   因此结果仍然必须落 R2，让每个 URL 一生只转换一次。
 *
 * 已知输出缺陷（实测，接受不修）：URL 中的下划线被过度编码成 %5F
 *   （/path/with_underscore → /path/with%5Funderscore）。%5F 解码即 _，
 *   功能无损，但对 Agent 客户是可见的 URL 噪声。
 * ============================================================
 */

import { estimateTokens } from "./utils.js";

// toMarkdown 的输入上限实测约 4 MiB（3.54 MiB 成功，5 MiB 报 6006）。
// 超限不是快速拒绝：5 MiB 会挂 41 秒才返回错误，所以这里提前拦截。
//
// 阈值按字符数而非字节数判定——html.length 是 UTF-16 单元数，中文一字占
// 3 字节。但真实 HTML 源码由标签/属性主导，CJK 占比通常 <1%（实测微信
// 3.54 MiB 文档 = 3,678,178 字符，字节/字符比 1.009），所以字符数≈字节数，
// 取 3.9M 字符即可覆盖 4 MiB 上限并留余量。
// 全 CJK 的退化输入（非真实 HTML 页面）会漏过这道门，最终由服务端的
// 6006 兜住——宁可这样，也不在 10ms CPU 预算里跑 TextEncoder 量字节。
const MAX_INPUT_CHARS = 3_900_000;

/**
 * 在文档里注入 <base href>，让转换器把相对链接解析成绝对 URL。
 *
 * 为什么用 <base> 而不是 conversionOptions.html.hostname：后者经 REST API
 * 有效，但经 Worker 绑定被静默忽略（x-dev 实测：78 个 /html/ 链接全部
 * 原样输出为相对路径）。官方文档对绑定如何传 conversionOptions 自相矛盾
 * 且全篇没有任何示例，属于不可依赖的接口，所以改用标准 HTML 语义。
 * 注入 <base> 后经 REST 验证与 hostname 输出逐字节一致。
 *
 * 注意二者绝不可叠加：同时给 <base> 和 hostname 会整个关闭链接解析。
 *
 * 已实测结论（2026-10）：经绑定 conversionOptions 整个对象都到不了服务端，
 * 不只是 hostname。试过 html.cssSelector，并且按文档签名
 * `toMarkdown(files, conversionOptions)` 放在第二个位置参数上，
 * x-dev 实测选择器完全不生效（页脚 chrome 全量出现）。
 * 所以任何需要裁剪/指定范围的诉求都必须在调用前由 Worker 自己改 HTML
 * 实现（/wechat/ 的页脚截断就是这条路），不要指望 conversionOptions。
 *
 * 插入位置紧跟 <head> 开标签之后。实测 <base> 不是 <head> 第一个子元素
 * 也照样生效；无 <head> 时前置到文档开头，片段输入同样生效。
 *
 * @param {string} html 待处理的 HTML
 * @param {string} origin 基准 URL，须以 "/" 结尾
 * @returns {string}
 */
function injectBase(html, origin) {
  const tag = '<base href="' + origin + '">';
  const m = /<head[^>]*>/i.exec(html);
  if (!m) return tag + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + tag + html.slice(at);
}

/**
 * 把 HTML 转成 Markdown。
 *
 * 单次调用，不重试：Workers AI 对 HTML 转换没有 Browser Run 那种 1 次/10 秒
 * 的速率限制，退避没有意义。任何失败都直接抛出，由调用方按内容协商语义
 * 返回 502，让客户端能区分「这条 URL 暂时转不出来」与「页面本身挂了」。
 *
 * @param {Object} env wrangler 注入的环境，需含 AI 绑定
 * @param {string} html 已完成资源改写的完整 HTML
 * @param {string} origin 本 Worker 的 https origin，用于解析相对链接
 * @returns {Promise<string>} Markdown 文本
 * @throws {Error} 绑定缺失 / 输入过大 / 转换失败 / 返回空结果
 */
export async function convertHtml(env, html, origin) {
  if (!env || !env.AI) throw new Error("AI binding missing");
  if (html.length > MAX_INPUT_CHARS) {
    throw new Error(
      "html too large: " + html.length + " chars (toMarkdown limit ~4 MiB)"
    );
  }

  // type 必须显式给 text/html：服务端按 blob 的 Content-Type 判定文档类型，
  // 不看 name 的文件扩展名（实测 name=a.txt + type=text/html 仍按 HTML 转）。
  const doc = await env.AI.toMarkdown({
    name: "page.html",
    blob: new Blob([injectBase(html, origin + "/")], { type: "text/html" }),
  });

  // 单文档输入按文档约定返回单个对象；数组兜底以防实现差异。
  const r = Array.isArray(doc) ? doc[0] : doc;
  if (!r || r.format === "error") {
    throw new Error((r && r.error) || "toMarkdown failed");
  }
  if (typeof r.data !== "string" || !r.data.trim()) {
    throw new Error("toMarkdown returned empty markdown");
  }
  return r.data;
}

/**
 * 组装 Markdown 响应。
 *
 * 必须带 Vary: Accept——同一个 URL 现在有 HTML / Markdown 两种表示，
 * 边缘不区分的话会把 HTML 直接喂给要 Markdown 的客户端。
 * 缓存一年：R2 已是唯一内容来源且永不过期，长 TTL 只让边缘少读几次 R2。
 *
 * @param {string} md Markdown 正文
 * @param {string} cacheState "hit" | "miss"
 * @returns {Response}
 */
export function markdownResponse(md, cacheState) {
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "cache-control": "public, max-age=31556952",
      "vary": "Accept",
      "access-control-allow-origin": "*",
      "x-cache": cacheState,
      "x-markdown-tokens": String(estimateTokens(md)),
    },
  });
}
