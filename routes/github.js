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
 * 通过 GitHub Contents API 拉取仓库 README 的预渲染 HTML。
 *
 * Accept: application/vnd.github.html → GitHub 返回渲染好的 HTML
 * （markdown 已转 HTML、代码已语法高亮），无需本端再做解析。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} [token] 可选的 GITHUB_TOKEN（pat），提升限流配额
 * @returns {{ ok: boolean, status: number, html: string, contentType: string }}
 */
async function fetchReadmeHtml(owner, repo, token) {
  const headers = {
    Accept: "application/vnd.github.html",
    "X-GitHub-Api-Version": "2022-11-28",
    // GitHub API 强制要求 User-Agent，否则 403
    "User-Agent": "x-page-worker (Cloudflare Worker; +https://github.com/)",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/readme`, {
    headers,
    cf: { cacheTtl: 300, cacheEverything: true }, // 5 分钟边缘缓存，降低 API 压力
  });

  if (!res.ok) return { ok: false, status: res.status, html: "", contentType: "" };
  const contentType = res.headers.get("content-type") || "";
  return { ok: true, status: 200, html: await res.text(), contentType };
}

/**
 * 把 README 的 HTML 片断包裹为完整的、自包含的页面。
 *
 * 顶部加一个 header 条显示仓库名并链回 GitHub，正文用 water.css
 * 兜底排版（GitHub 预渲染 HTML 自带类名但没有 CSS，靠 water 的
 * 基础样式保证可读）；代码块 / 表格 / 图片约束在容器宽度内。
 *
 * @param {string} readmeHtml 已改写资源路径的 README body
 * @param {string} owner
 * @param {string} repo
 * @param {string} waterCss water.css 源码字符串
 * @returns {string} 完整 HTML 文档
 */
function wrapPage(readmeHtml, owner, repo, waterCss) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeOwner}/${safeRepo} · README</title>
    <style>
    ${waterCss}
    /* GitHub README 预览的轻量补充样式（仅布局兜底，不抢 water 的风头） */
    body { max-width: 980px; }
    .gh-header { display:flex; align-items:center; gap:8px; padding:10px 16px; border-bottom:1px solid var(--border); margin-bottom:16px; flex-wrap:wrap; }
    .gh-header a { color: var(--text-muted); text-decoration:none; }
    .gh-header .gh-brand { font-weight:600; color:var(--text-main); }
    .gh-header .gh-sep { color: var(--text-muted); }
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
    <div class="gh-header">
        <a href="https://github.com/${safeOwner}" class="gh-brand">${safeOwner}</a>
        <span class="gh-sep">/</span>
        <a href="${repoUrl}" class="gh-brand">${safeRepo}</a>
        <span class="gh-sep">·</span>
        <a href="${repoUrl}" rel="nofollow">View on GitHub ↗</a>
    </div>
    <div id="readme" class="markdown-body">
        ${readmeHtml}
    </div>
</body>
</html>`;
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
 * 处理 /github/<user>/<repo> 请求。
 *
 * @param {Request} _request 入站请求（本路由仅从路径取参数，未使用 request 体）
 * @param {Object} env wrangler 注入的环境变量（含可选 GITHUB_TOKEN）
 * @param {string} cleanPath 去首斜杠 + decode 后的路径，如 "github/iOfficeAI/OfficeCLI"
 * @param {string} waterCss water.css 源码字符串
 * @returns {Response}
 */
export async function serveGithub(_request, env, cleanPath, waterCss) {
  const rest = cleanPath.slice("github/".length);
  if (!rest) return new Response("missing owner/repo", { status: 400 });

  // 只取前两层：owner/repo；多余段位（如误粘贴树路径）直接截掉。
  const [owner, repoRaw] = rest.split("/");
  if (!owner || !repoRaw) return new Response("missing owner/repo", { status: 400 });
  const repo = repoRaw.split(/[/?#]/)[0];
  if (!repo) return new Response("missing repo", { status: 400 });

  const token = (env && env.GITHUB_TOKEN) || "";
  const { ok, status, html, contentType } = await fetchReadmeHtml(owner, repo, token);
  if (!ok) {
    const msg =
      status === 404
        ? "Repository or README not found (404)"
        : status === 403
        ? "GitHub API rate limit exceeded (403) — set GITHUB_TOKEN to raise the limit"
        : `GitHub API error (${status})`;
    return new Response(errorPage(owner, repo, msg), {
      status: status === 404 ? 404 : 502,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  // 容错：GitHub 若未按 Accept 头返回 HTML（回退到 JSON body），
  // 直接透传原文，避免把错误/元数据 JSON 当 README 改写。
  // 与 /html/ 的「非 HTML 原样透传」策略一致。
  if (!contentType.includes("html")) {
    return new Response(html, {
      headers: {
        "content-type": contentType || "text/plain; charset=utf-8",
        "cache-control": "public, max-age=300",
      },
    });
  }

  const rewriter = buildRewriter(owner, repo);

  // HTMLRewriter 在 Workers 上是流式、零额外内存；
  // 失败时降级返回原始 HTML（资源不走代理，至少内容可读）。
  // 与 /html/ 的「改写失败 → 退回原始 HTML 兜底」策略一致。
  let bodyHtml;
  try {
    const transformed = rewriter.transform(new Response(html));
    bodyHtml = await transformed.text();
  } catch (e) {
    bodyHtml = html;
  }

  const page = wrapPage(bodyHtml, owner, repo, waterCss);
  return new Response(page, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=300",
    },
  });
}

/** 简易错误页，保持与成功页一致的 header 壳。 */
function errorPage(owner, repo, message) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${escapeHtml(
    owner
  )}/${escapeHtml(repo)} · README</title></head><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:0 16px">
<h2>${escapeHtml(owner)}/${escapeHtml(repo)}</h2>
<p style="color:#b00020">${escapeHtml(message)}</p>
<p><a href="https://github.com/${escapeHtml(owner)}/${escapeHtml(repo)}">View on GitHub ↗</a></p>
</body></html>`;
}
