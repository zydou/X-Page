/**
 * lib/markdown.js
 * ============================================================
 * Worker 端 markdown → HTML 渲染器，代码块由 highlight.js 着色。
 *
 * 用 markdown-it（markdown-it.mjs，CI 用 esbuild 把 npm markdown-it
 * 打成自包含 ESM）解析 GFM markdown（表格 / 任务列表 / 删除线 /
 * fenced code blocks），在 render 时通过它的 highlight 选项把
 * 代码块交给 hljs 着色：
 *   - 语言被 hljs 识别 → 返回已着色的 <span class="hljs-xxx"> HTML
 *   - 语言未识别 → 返回空串，由 markdown-it 走默认转义并保留
 *     language-xxx class（保持 CSS 钩子一致）
 *
 * 被谁调用：routes/github.js 的文档路径（README/.md）。
 * ============================================================
 */

import { MarkdownIt } from "../markdown-it.mjs";

let cachedRenderer = null;

/**
 * 创建一个配置好 highlight 函数的 markdown-it 渲染器。
 *
 * @param {object} hljs highlight.js 命名空间（worker.js 传入的 highlight.mjs 导出）
 * @returns {(raw: string) => string} markdown → HTML 渲染函数
 */
export function createMarkdownRenderer(hljs) {
  if (cachedRenderer) return cachedRenderer;

  const md = new MarkdownIt({
    html: true, // 允许原始 HTML（GitHub markdown 里常见）
    linkify: true, // 自动识别 URL 为链接
    typographer: false, // 不用智能引号（避免与代码冲突）
    highlight: (str, lang) => {
      if (lang && hljs && hljs.getLanguage && hljs.getLanguage(lang)) {
        try {
          return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        } catch {
          // 着色失败 → 退化到默认
        }
      }
      // 未识别或无语言 → 返回空，markdown-it 会走默认转义
      // 并保留 `language-xxx` class 作为 CSS 钩子
      return "";
    },
  });

  cachedRenderer = (raw) => md.render(raw);
  return cachedRenderer;
}
