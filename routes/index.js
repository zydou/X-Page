/**
 * routes/index.js
 * ============================================================
 * 根路由 "/" → 302 跳转到 GitHub 项目主页。
 * ============================================================
 */

const GITHUB_REPO = "https://github.com/zydou/X-Page";

/**
 * 根路径 "/" 的主入口：302 跳转到 GitHub。
 *
 * @param {string} _host 当前 Worker 的 Host（保留参数以兼容 worker.js 调用方）
 * @returns {Response} 302 重定向到 GitHub
 */
export function indexHtml(_host) {
  return new Response(null, {
    status: 302,
    headers: { location: GITHUB_REPO },
  });
}
