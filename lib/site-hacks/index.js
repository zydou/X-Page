/**
 * lib/site-hacks/index.js
 * ============================================================
 * 站点专属 hack 注册表。
 *
 * /html/（以及复用其 buildRewriter 的 /wechat/）是通用 HTML 代理，
 * 但个别站点会在客户端做反镜像检测、强制跳转、或带污染渲染的
 * 内联逻辑。这类问题没法用通用规则解决，只能针对具体站点精确
 * 中和。本目录按"一站点一文件"存放这些 hack，各自隔离、互不影响。
 *
 * 每个 hack 模块导出两个成员：
 *   - matches  (host) => boolean，判断是否适用于该目标 host
 *   - sanitize (html) => string，对完整 HTML 字符串做精确中和
 *
 * 为什么是「整篇字符串后处理」而不是往 HTMLRewriter 上挂处理器：
 *   要中和的往往是 <script> 的「内容」，而 HTMLRewriter 是流式的——
 *   script 正文被切成多个 text chunk，标记可能正好跨在 chunk 边界
 *   导致 includes() 落空；且内容一旦流式输出就无法用 remove() 撤回。
 *   在缓冲好的完整 HTML 字符串上做正则整段替换对这两点都免疫，
 *   也能精确区分「可执行的那一份」和 Next.js flight payload 里的
 *   「数据副本」，避免误删导致页面停在骨架屏。
 *
 * 调用方（routes/html.js）在缓冲出完整 HTML 后调用
 * resolveSiteHack(host) + applySiteHack，命中就对整篇做一次 sanitize。
 * 通用资源改写仍走 HTMLRewriter 流式完成，hack 只叠加最后一步。
 * 新增站点：在 HACKS 里加一条 import + 条目，并在站点文件里写 sanitize。
 * ============================================================
 */

import * as openrouter from "./openrouter.js";

/**
 * 所有站点 hack。新增站点：在此追加一条。
 *
 * @type {Array<{matches: (host: string) => boolean, sanitize: (html: string) => string}>}
 */
const HACKS = [openrouter];

/**
 * 解析目标 host 命中的第一个 hack。
 *
 * @param {string} host 被代理页的 hostname
 * @returns {object|null} 命中的 hack 模块，未命中返回 null
 */
export function resolveSiteHack(host) {
  if (!host) return null;
  return HACKS.find((h) => h.matches(host)) || null;
}

/**
 * 对完整 HTML 字符串应用命中的 hack。
 *
 * @param {string} html 缓冲好的完整 HTML
 * @param {object|null} hack resolveSiteHack 的返回值
 * @returns {string} 中和后的 HTML；未命中 hack 时原样返回
 */
export function applySiteHack(html, hack) {
  return hack ? hack.sanitize(html) : html;
}
