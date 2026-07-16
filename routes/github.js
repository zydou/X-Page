/**
 * routes/github.js
 * ============================================================
 * GitHub README 自述页渲染：/github/<user>/<repo>
 *
 * 让 Worker 作为中立客户端调 GitHub Contents API，直接拿到
 * 仓库 README 的预渲染 HTML（markdown → HTML + 语法高亮已由
 * GitHub 完成），把里面的 <img>/<video>/<source> 改写为内部
 * /proxy/<encoded> 路径后套上 water.css 展示。
 *
 * 设计取舍：
 *   - 走 GitHub 预渲染 HTML 而不是自写 markdown 解析器：
 *     语法高亮 / 表格 / GFM 任务列表全部复用 GitHub 的产出，
 *     保真度高、体积小、维护成本低。
 *   - 单 API 调用：README 接口直接返回 HTML（Accept 头控制），
 *     不额外调 /repos 取 metadata。相对路径 asset 用
 *     raw.githubusercontent.com/{owner}/{repo}/HEAD/ 兜底解析，
 *     无需再查 default_branch，省下一次配额（无 token 时仅 60 次/h）。
 *   - 限流：通过 [vars] GITHUB_TOKEN 传入可选 token，未配置也能用
 *     （仅公共仓库，受未认证 60次/h 限制）。
 *
 * 资源改写范围：
 *   <img src/data-canonical-src>  <video src>  <source src>
 *   其它锚点 / 样式链均保留原样（README 链接交给浏览器自己处理）。
 *
 * 被谁调用：入口直接匹配 /github/ 前缀。
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";

/**
 * 是否值得改写为 /proxy/ 路径。
 * 过滤 data: / blob: / javascript: / 锚点，以及已改写的内部路径。
 *
 * @param {string|undefined} url
 * @returns {boolean}
 */
function shouldProxy(url) {
  if (!url) return false;
  const t = url.trim();
  if (!t) return false;
  if (/^(data:|blob:|javascript:|#)/i.test(t)) return false;
  if (t.startsWith("/proxy/")) return false;
  return true;
}

/**
 * 把可能为相对路径的 URL 解析为绝对 URL。
 * base 取 raw.githubusercontent.com 的 HEAD 分支兜底路径，
 * 让 assets/foo.png 这类仓库内相对引用也能解析。
 *
 * @param {string} url
 * @param {string} owner
 * @param {string} repo
 * @returns {string}
 */
function resolveUrl(url, owner, repo) {
  try {
    return new URL(url, `${RAW_BASE}/${owner}/${repo}/HEAD/`).href;
  } catch {
    return url;
  }
}

/**
 * 为 README 的预渲染 HTML 构建 HTMLRewriter，只改写媒体资源路径。
 *
 * 媒体改写策略：
 *   - <img>：优先取 data-canonical-src（GitHub 对 camo 代理图的
 *     真实源 URL，如 shields.io），没有再用 src；相对路径统一 resolve。
 *   - <video>/<source>：改 src。
 *
 * @param {string} owner
 * @param {string} repo
 * @returns {HTMLRewriter}
 */
function buildRewriter(owner, repo) {
  const rewriter = new HTMLRewriter();

  function proxyImgSrc(imgEl) {
    // data-canonical-src 是 camo 代理图对应的真实原始 URL，
    // 优先用它代理（camo 链接有时效、且自带 recompress），
    // 没有再退回 src。
    const canonical = imgEl.getAttribute("data-canonical-src");
    const src = imgEl.getAttribute("src");
    const raw = canonical || src;
    if (!shouldProxy(raw)) return;
    const absolute = resolveUrl(raw, owner, repo);
    imgEl.setAttribute("src", proxyUrl(absolute));
  }

  function proxyMediaSrc(el) {
    const src = el.getAttribute("src");
    if (!shouldProxy(src)) return;
    el.setAttribute("src", proxyUrl(resolveUrl(src, owner, repo)));
  }

  // <a>：仅改写相对路径的资源链接为 /proxy/<resolved>，
  // 修复「图片被 <a href="assets/x.png"> 包裹 → 点击解析到不存在的
  // /github/<user>/<repo>/assets/x.png」的问题。
  // 绝对地址的外部链接保持原样（直接跳转）；# 锚点由 shouldProxy 过滤。
  function proxyAnchor(el) {
    const href = el.getAttribute("href");
    if (!shouldProxy(href)) return;
    if (/^https?:\/\//i.test(href.trim())) return;
    el.setAttribute("href", proxyUrl(resolveUrl(href, owner, repo)));
  }

  rewriter.on("img", { element: proxyImgSrc });
  rewriter.on("video", { element: proxyMediaSrc });
  rewriter.on("source", { element: proxyMediaSrc });
  rewriter.on("a", { element: proxyAnchor });

  return rewriter;
}

/**
 * 获取仓库元数据：owner 头像、star / fork / watching 数量。
 * 与 fetchReadmeHtml 并行发出（Promise.all），不增加往返。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} [token] 可选的 GITHUB_TOKEN（pat），提升限流配额
 * @returns {{ ok: boolean, status: number, avatarUrl: string, stars: number, forks: number, watching: number }}
 */
async function fetchRepoMeta(owner, repo, token) {
  const headers = {
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "x-page-worker (Cloudflare Worker; +https://github.com/)",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, {
    headers,
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return { ok: false, status: res.status, avatarUrl: "", stars: 0, forks: 0, watching: 0 };
  const d = await res.json();
  return {
    ok: true,
    status: 200,
    avatarUrl: (d?.owner?.avatar_url) || "",
    stars: d?.stargazers_count || 0,
    forks: d?.forks_count || 0,
    watching: d?.subscribers_count || 0,
  };
}

/**
 * 获取仓库内容：默认 README、指定文件（渲染后 HTML）或目录列表。
 *
 * - filePath 为空 → 调 /readme 端点，GitHub 自动解析默认 README
 *   （无论 README.md / readme.md / README / README.rst 都能正确返回）。
 * - filePath 非空 → 调 /contents/{path}：
 *     - 文件 → 返回渲染好的 HTML（Accept: html）
 *     - 目录 → 返回 JSON 数组（即便请求了 html accept）
 *     - 二进制等不支持 html 渲染 → 403
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath 文件路径（可为空 → 默认 README）
 * @param {string} [token] 可选的 GITHUB_TOKEN（pat），提升限流配额
 * @returns {{ ok, status, type: "file"|"dir"|"error", html, contentType, listing }}
 */
async function fetchContent(owner, repo, filePath, token) {
  const headers = {
    Accept: "application/vnd.github.html",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub API 强制要求 User-Agent，否则 403
    "User-Agent": "x-page-worker (Cloudflare Worker; +https://github.com/)",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  // 空路径 → 默认 README；非空 → 指定路径
  const url = filePath
    ? `${GITHUB_API}/repos/${owner}/${repo}/contents/${filePath}`
    : `${GITHUB_API}/repos/${owner}/${repo}/readme`;

  const res = await fetch(url, {
    headers,
    cf: { cacheTtl: 300, cacheEverything: true }, // 5 分钟边缘缓存，降低 API 压力
  });

  if (!res.ok) return { ok: false, status: res.status, type: "error", html: "", contentType: "", listing: [] };
  const contentType = res.headers.get("content-type") || "";

  // 文件：html accept 返回渲染好的 HTML
  if (contentType.includes("html")) {
    return { ok: true, status: 200, type: "file", html: await res.text(), contentType, listing: [] };
  }

  // 目录：GitHub 对目录返回 JSON 数组（即便请求了 html accept）
  if (contentType.includes("application/json")) {
    const data = await res.json();
    if (Array.isArray(data)) {
      return { ok: true, status: 200, type: "dir", html: "", contentType, listing: data };
    }
    // 非数组的 JSON（如二进制文件的 403 错误信息）→ 无法 html 渲染
    return { ok: false, status: res.status, type: "error", html: "", contentType, listing: [] };
  }

  return { ok: false, status: res.status, type: "error", html: "", contentType, listing: [] };
}

/**
 * 把 README 的 HTML 片断包裹为完整的、自包含的页面。
 *
 * 顶部 header 仿照 tweet 的 .gh-header 布局：左侧圆角 avatar + 蓝色
 * 仓库路径（owner/repo），右侧 Watch / Star / Fork 统计（仿 GitHub 原生）。
 * 正文用 water.css 兜底排版；代码块 / 表格 / 图片约束在容器宽度内。
 *
 * @param {string} readmeHtml 已改写资源路径的 README body
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath 文件路径（空串 = 默认 README）
 * @param {string} meta 元数据 { avatarUrl, stars, forks, watching }
 * @param {string} waterCss water.css 源码字符串
 * @returns {string} 完整 HTML 文档
 */
function wrapPage(readmeHtml, owner, repo, filePath, meta, waterCss) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const safePath = escapeHtml(filePath);
  const avatarUrl = meta?.avatarUrl ? proxyUrl(meta.avatarUrl) : "";

  // 头部路径：默认 README 显示 user/repo，指定文件显示 user/repo/path。
  const pathDisplay = filePath
    ? `<a href="https://github.com/${safeOwner}" target="_blank">${safeOwner}</a><span class="gh-sep">/</span><a href="${repoUrl}" target="_blank">${safeRepo}</a><span class="gh-sep">/</span><a href="${repoUrl}/blob/HEAD/${safePath}" target="_blank">${safePath}</a>`
    : `<a href="https://github.com/${safeOwner}" target="_blank">${safeOwner}</a><span class="gh-sep">/</span><a href="${repoUrl}" target="_blank">${safeRepo}</a>`;

  // 头像：有则显示，无则留空占位（保持布局不变）。
  const avatarTag = avatarUrl
    ? `<a href="https://github.com/${safeOwner}" target="_blank"><img src="${avatarUrl}" class="gh-avatar"></a>`
    : `<div class="gh-avatar gh-avatar-ph"></div>`;

  const titleSuffix = filePath ? ` · ${safePath}` : " · README";
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeOwner}/${safeRepo}${titleSuffix}</title>
    <style>
    ${waterCss}
    /* gh-header 布局（仿照 twitter.css 的 .gh-header，内联以便独立修改） */
    .gh-header { display:flex; align-items:center; margin-bottom:12px; }
    .gh-avatar { width:36px; height:36px; border-radius:50%; margin-right:12px; object-fit:cover; }
    .gh-info { display:flex; flex-direction:column; justify-content:center; line-height:1.4; }
    /* GitHub README 预览的轻量补充样式（仅布局兜底，不抢 water 的风头） */
    body { max-width: 980px; }
    /* header：左右两栏，左侧仿 tweet，右侧统计 */
    .gh-topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:10px 16px; border-bottom:1px solid var(--border); margin-bottom:16px; flex-wrap:wrap; }
    .gh-topbar .gh-header { margin-bottom:0; border-bottom:none; padding:0; }
    .gh-avatar-ph { background: var(--background-alt); }
    /* 仓库路径：owner/repo 用tweet-author 蓝色，分隔符改用-muted */
    .gh-repo-path { font-size:1.1em; font-weight:bold; }
    .gh-repo-path a { color: var(--links); text-decoration:none; }
    .gh-repo-path .gh-sep { color: var(--text-muted); font-weight:400; margin:0 4px; }
    /* 右侧统计：Watch / Star / Fork，仿 GitHub 原生胶囊造型 */
    .gh-stats { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .gh-stat { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.85em; color:var(--text-main); text-decoration:none; background:var(--background-alt); white-space:nowrap; }
    .gh-stat:hover { text-decoration:none; background:var(--background); }
    .gh-stat .gh-stat-count { font-weight:700; }
    .gh-stat .gh-stat-icon { font-size:0.95em; }
    /* GitHub 预渲染 README 的容器与媒体约束 */
    .markdown-body, #readme { word-wrap: break-word; overflow-wrap: anywhere; }
    /* 隐藏 GitHub 给标题加的永久链接锚点（<a class="anchor"> + 饼齿 # 图标）：
       脱离 GitHub 自带 CSS 后它会渲染成一个独立链接符号占一整行，
       且点击跳的是当前页 #xxx 锚点，在代理页面里完全无用。 */
    .markdown-body a.anchor, #readme a.anchor { display: none; }
    .markdown-body img, #readme img { max-width: 100%; height: auto; box-sizing: border-box; }
    .markdown-body video, #readme video { max-width: 100%; }
    .markdown-body pre, #readme pre { overflow-x: auto; }
    .markdown-body table, #readme table { max-width: 100%; display: block; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="gh-topbar">
        <div class="gh-header">
            ${avatarTag}
            <div class="gh-info">
                <div class="gh-repo-path">
                    ${pathDisplay}
                </div>
            </div>
        </div>
        <div class="gh-stats">
            <a href="${repoUrl}/watchers" target="_blank" class="gh-stat"><span class="gh-stat-icon">👁</span> Watch <span class="gh-stat-count">${formatCount(meta?.watching ?? 0)}</span></a>
            <a href="${repoUrl}/stargazers" target="_blank" class="gh-stat"><span class="gh-stat-icon">⭐</span> Star <span class="gh-stat-count">${formatCount(meta?.stars ?? 0)}</span></a>
            <a href="${repoUrl}/forks" target="_blank" class="gh-stat"><span class="gh-stat-icon">🍴</span> Fork <span class="gh-stat-count">${formatCount(meta?.forks ?? 0)}</span></a>
        </div>
    </div>
    <div id="readme" class="markdown-body">
        ${readmeHtml}
    </div>
</body>
</html>`;
}

/**
 * 渲染目录列表页：列出目录下的文件与子目录，可点击进入。
 *
 * @param {Array} listing GitHub Contents API 返回的目录项数组
 * @param {string} owner
 * @param {string} repo
 * @param {string} dirPath 当前目录路径（空串 = 根目录）
 * @param {string} meta 元数据 { avatarUrl, stars, forks, watching }
 * @param {string} waterCss water.css 源码字符串
 * @returns {string} 完整 HTML 文档
 */
function renderDirListing(listing, owner, repo, dirPath, meta, waterCss) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const avatarUrl = meta?.avatarUrl ? proxyUrl(meta.avatarUrl) : "";

  // 头部路径：根目录显示 user/repo，子目录显示 user/repo/path。
  const pathDisplay = dirPath
    ? `<a href="/github/${safeOwner}/${safeRepo}">${safeOwner}/${safeRepo}</a><span class="gh-sep">/</span><a href="${repoUrl}/tree/HEAD/${escapeHtml(dirPath)}" target="_blank">${escapeHtml(dirPath)}</a>`
    : `<a href="https://github.com/${safeOwner}" target="_blank">${safeOwner}</a><span class="gh-sep">/</span><a href="${repoUrl}" target="_blank">${safeRepo}</a>`;

  const avatarTag = avatarUrl
    ? `<a href="https://github.com/${safeOwner}" target="_blank"><img src="${avatarUrl}" class="gh-avatar"></a>`
    : `<div class="gh-avatar gh-avatar-ph"></div>`;

  // 父目录链接（根目录时隐藏）。
  let parentLink = "";
  if (dirPath) {
    const parentParts = dirPath.split("/");
    parentParts.pop();
    const parentPath = parentParts.join("/");
    const parentHref = parentPath
      ? `/github/${safeOwner}/${safeRepo}/${parentPath}`
      : `/github/${safeOwner}/${safeRepo}`;
    parentLink = `<a href="${parentHref}" class="gh-dir-parent">..</a>`;
  }

  // 目录优先、文件次之，各自按名称排序。
  const dirs = listing.filter((i) => i.type === "dir").sort((a, b) => a.name.localeCompare(b.name));
  const files = listing.filter((i) => i.type === "file").sort((a, b) => a.name.localeCompare(b.name));

  const renderItem = (item) => {
    const name = escapeHtml(item.name);
    const href = `/github/${safeOwner}/${safeRepo}/${(dirPath ? dirPath + "/" : "") + item.name}`;
    const icon = item.type === "dir" ? "📁" : "📄";
    const size = item.type === "file" ? `<span class="gh-dir-size">${formatSize(item.size)}</span>` : "";
    return `<a href="${href}" class="gh-dir-item"><span class="gh-dir-icon">${icon}</span> ${name}${size}</a>`;
  };

  const itemsHtml = [...dirs, ...files].map(renderItem).join("\n");

  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeOwner}/${safeRepo}${dirPath ? " / " + escapeHtml(dirPath) : ""} · GitHub</title>
    <style>
    ${waterCss}
    /* gh-header 布局（仿照 twitter.css 的 .gh-header，内联以便独立修改） */
    .gh-header { display:flex; align-items:center; margin-bottom:12px; }
    .gh-avatar { width:36px; height:36px; border-radius:50%; margin-right:12px; object-fit:cover; }
    .gh-info { display:flex; flex-direction:column; justify-content:center; line-height:1.4; }
    body { max-width: 980px; }
    .gh-topbar { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:10px 16px; border-bottom:1px solid var(--border); margin-bottom:16px; flex-wrap:wrap; }
    .gh-topbar .gh-header { margin-bottom:0; border-bottom:none; padding:0; }
    .gh-avatar-ph { background: var(--background-alt); }
    .gh-repo-path { font-size:1.1em; font-weight:bold; }
    .gh-repo-path a { color: var(--links); text-decoration:none; }
    .gh-repo-path .gh-sep { color: var(--text-muted); font-weight:400; margin:0 4px; }
    .gh-stats { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
    .gh-stat { display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border:1px solid var(--border); border-radius:6px; font-size:0.85em; color:var(--text-main); text-decoration:none; background:var(--background-alt); white-space:nowrap; }
    .gh-stat:hover { text-decoration:none; background:var(--background); }
    .gh-stat .gh-stat-count { font-weight:700; }
    .gh-stat .gh-stat-icon { font-size:0.95em; }
    /* 目录列表 */
    .gh-dir-parent { display:inline-block; margin-bottom:10px; padding:4px 10px; border:1px solid var(--border); border-radius:6px; color:var(--links); text-decoration:none; font-size:0.9em; }
    .gh-dir-parent:hover { text-decoration:underline; }
    .gh-dir-list { border:1px solid var(--border); border-radius:6px; overflow:hidden; }
    .gh-dir-item { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border); text-decoration:none; color:var(--text-main); }
    .gh-dir-item:last-child { border-bottom:none; }
    .gh-dir-item:hover { background:var(--background-alt); }
    .gh-dir-icon { font-size:1em; }
    .gh-dir-size { margin-left:auto; color:var(--text-muted); font-size:0.85em; }
    </style>
</head>
<body>
    <div class="gh-topbar">
        <div class="gh-header">
            ${avatarTag}
            <div class="gh-info">
                <div class="gh-repo-path">
                    ${pathDisplay}
                </div>
            </div>
        </div>
        <div class="gh-stats">
            <a href="${repoUrl}/watchers" target="_blank" class="gh-stat"><span class="gh-stat-icon">👁</span> Watch <span class="gh-stat-count">${formatCount(meta?.watching ?? 0)}</span></a>
            <a href="${repoUrl}/stargazers" target="_blank" class="gh-stat"><span class="gh-stat-icon">⭐</span> Star <span class="gh-stat-count">${formatCount(meta?.stars ?? 0)}</span></a>
            <a href="${repoUrl}/forks" target="_blank" class="gh-stat"><span class="gh-stat-icon">🍴</span> Fork <span class="gh-stat-count">${formatCount(meta?.forks ?? 0)}</span></a>
        </div>
    </div>
    <div class="gh-dir-list">
        ${parentLink}
        ${itemsHtml}
    </div>
</body>
</html>`;
}

/** 格式化文件大小：1024 → "1.0 KB"。 */
function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

/** HTML 实体转义，避免 owner/repo 中的特殊字符破坏模板。 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 给统计数字做简短格式化：17867 → "17.9k"，<1000 原样输出。
 *
 * @param {number} n
 * @returns {string}
 */
function formatCount(n) {
  if (!n || n < 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "m";
}

/**
 * 处理 /github/<user>/<repo>[/<path>] 请求。
 *
 * 路径形态：
 *   /github/<user>/<repo>            → 默认 README
 *   /github/<user>/<repo>/<path>     → 指定文件（渲染后 HTML）或目录（文件列表）
 *
 * @param {Request} _request 入站请求（本路由仅从路径取参数，未使用 request 体）
 * @param {Object} env wrangler 注入的环境变量（含可选 GITHUB_TOKEN）
 * @param {string} cleanPath 去首斜杠 + decode 后的路径，如 "github/iOfficeAI/OfficeCLI/npm/package.json"
 * @param {string} waterCss water.css 源码字符串
 * @returns {Response}
 */
export async function serveGithub(_request, env, cleanPath, waterCss) {
  const rest = cleanPath.slice("github/".length);
  if (!rest) return new Response("missing owner/repo", { status: 400 });

  // 解析 owner/repo/filePath：前两层为 owner/repo，剩余拼成 filePath。
  const parts = rest.split("/");
  const owner = parts[0];
  const repo = (parts[1] || "").split(/[/?#]/)[0];
  if (!owner || !repo) return new Response("missing owner/repo", { status: 400 });
  const filePath = parts.slice(2).join("/").split(/[?#]/)[0];

  // 路径穿越防护：拒绝含 ".." 的段位（GitHub 自身也返回 404，但显式拦截更安全）。
  if (filePath.split("/").some((seg) => seg === "..")) {
    return new Response("invalid path", { status: 400 });
  }

  const token = (env && env.GITHUB_TOKEN) || "";
  // 内容（README/文件/目录）与元数据（头像/star/fork/watching）并行请求，不增加往返。
  const [content, meta] = await Promise.all([
    fetchContent(owner, repo, filePath, token),
    fetchRepoMeta(owner, repo, token),
  ]);

  // 错误（404 / 403 / 其他）→ 友好错误页。
  if (!content.ok) {
    const msg =
      content.status === 404
        ? filePath
          ? `File or directory not found: ${filePath} (404)`
          : "Repository or README not found (404)"
        : content.status === 403
        ? "GitHub API rate limit exceeded (403) — set GITHUB_TOKEN to raise the limit"
        : `GitHub API error (${content.status})`;
    return new Response(errorPage(owner, repo, filePath, msg), {
      status: content.status === 404 ? 404 : 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 目录 → 渲染文件列表页。
  if (content.type === "dir") {
    const page = renderDirListing(content.listing, owner, repo, filePath, meta, waterCss);
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }

  // 文件（或默认 README）→ 渲染内容页。
  const rewriter = buildRewriter(owner, repo);

  // HTMLRewriter 在 Workers 上是流式、零额外内存；
  // 失败时降级返回原始 HTML（资源不走代理，至少内容可读）。
  // 与 /html/ 的「改写失败 → 退回原始 HTML 兜底」策略一致。
  let bodyHtml;
  try {
    const transformed = rewriter.transform(new Response(content.html));
    bodyHtml = await transformed.text();
  } catch (e) {
    bodyHtml = content.html;
  }

  const page = wrapPage(bodyHtml, owner, repo, filePath, meta, waterCss);
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

/** 简易错误页，保持与成功页一致的 header 壳。 */
function errorPage(owner, repo, filePath, message) {
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const safePath = escapeHtml(filePath || "");
  const pathDisplay = safePath
    ? `${safeOwner}/${safeRepo}/${safePath}`
    : `${safeOwner}/${safeRepo}`;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${pathDisplay} · GitHub</title></head><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px">
<h2>${pathDisplay}</h2>
<p style="color:#b00020">${escapeHtml(message)}</p>
<p><a href="https://github.com/${safeOwner}/${safeRepo}">View on GitHub ↗</a></p>
</body></html>`;
}
