/**
 * routes/github.js
 * ============================================================
 * GitHub README / 代码文件渲染：/github/<user>/<repo>[/<path>]
 *
 * 让 Worker 作为中立客户端调 GitHub Contents API，拉取仓库
 * README / 指定文件的原始 markdown 源码，再走 GitHub 的
 * /markdown/raw 端点渲染成 HTML（GFM 任务列表 / 表格 / 删除线
 * 全部复用 GitHub 的产出），把里面的 <img>/<video>/<source>
 * 改写为内部 /proxy/<encoded> 路径后套上 water.css 展示。
 *
 * 设计取舍：
 *   - 走 raw 源码 + /markdown/raw 渲染，而不是 github.html accept：
 *     github.html 会把 img src 转成 private-user-images 的 JWT URL，
 *     JWT 几分钟失效但 HTML 缓存 5 分钟 → 图片变死链。raw 路线
 *     下 GitHub 把外部图走 camo 代理（稳定），user-attachments
 *     保留干净 URL（无 JWT），彻底解决图片过期问题。
 *   - 双 API 调用（raw + markdown render），比 github.html 多一次，
 *     但换来图片长期可用 + 代码块可后期加 highlight。
 *     无 token 时受 60次/h 限制；配 GITHUB_TOKEN 提到 5000次/h。
 *   - 相对路径 asset 用 raw.githubusercontent.com 兜底解析，
 *     无需再查 default_branch，省下一次配额。
 *
 * 文件类型分流（方案一）：
 *   - 文档（.md/.rst/.org 等）：拉 raw 源码 → /markdown/raw 渲染；
 *     输出 HTML 里已有 Pygments token <span class="pl-xxx">，
 *     追加 pygments.css（light + dark，dark 用 @media 包裹）上色。
 *   - 代码文件（.ts/.py/.go …）：拉 raw 源码，Worker 端用
 *     highlight.js 的 hljs.highlight() 纯函数直接产出着色好的
 *     静态 HTML（浏览器零 JS）。内置 15 种核心语言；其余语言
 *     Worker 按需 fetch 语言模块后注册再高亮，理论上支持全部 192 种。
 *     主题 CSS（github + github-dark，dark 用 @media 包裹）内联到
 *     <style>，prefers-color-scheme 自动切换。
 *
 * 资源改写范围：
 *   <img src/data-canonical-src>  <video src>  <source src>
 *   其它锚点 / 样式链均保留原样。
 *
 * 被谁调用：入口直接匹配 /github/ 前缀。
 * ============================================================
 */

import { proxyUrl } from "../lib/utils.js";
import { createMarkdownRenderer } from "../lib/markdown.js";

const GITHUB_API = "https://api.github.com";
const RAW_BASE = "https://raw.githubusercontent.com";
const HLJS_LANG_CDN = "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/languages";

// Worker 端语言模块内存缓存（同 isolate 内跨请求复用，叠加 cf 边缘缓存）。
const LANG_MODULE_CACHE = new Map();

// markdown 渲染器（首次 serveGithub 时惰性创建，绑定 hljs）。
let markdownRenderer = null;

// 代码文件最大源码长度：超出则退化为纯文本 <pre>，避免 Worker CPU 爆表。
const CODE_MAX_CHARS = 200000;

/** 文档扩展名：走 GitHub API 渲染 + Pygments CSS 上色。 */
const DOC_EXTS = new Set(["md", "markdown", "mdown", "mkdn", "mdx", "rst", "org"]);

/**
 * 代码文件扩展名 → highlight.js 语言名 映射。
 * 覆盖 34 种常用语言；含 Dockerfile / Makefilie 等无扩展名风格的同名文件。
 * 值是 highlight.js 的语言标识，不一定是内置 15 种（非内置走按需 fetch）。
 */
const CODE_LANG = new Map([
  ["js", "javascript"], ["mjs", "javascript"], ["cjs", "javascript"], ["jsx", "javascript"],
  ["ts", "typescript"], ["tsx", "typescript"], ["mts", "typescript"],
  ["py", "python"], ["go", "go"], ["rs", "rust"],
  ["c", "c"], ["h", "c"],
  ["cpp", "cpp"], ["cc", "cpp"], ["cxx", "cpp"], ["hpp", "cpp"],
  ["cs", "csharp"], ["java", "java"], ["rb", "ruby"], ["php", "php"],
  ["swift", "swift"], ["kt", "kotlin"], ["kts", "kotlin"], ["scala", "scala"],
  ["sh", "bash"], ["bash", "bash"], ["zsh", "bash"],
  ["ps1", "powershell"], ["sql", "sql"], ["json", "json"],
  ["yaml", "yaml"], ["yml", "yaml"],
  ["xml", "xml"], ["html", "html"], ["htm", "html"],
  ["css", "css"], ["scss", "css"], ["less", "css"],
  ["dockerfile", "dockerfile"],
  ["mk", "makefile"], ["makefile", "makefile"],
  ["vim", "vim"], ["lua", "lua"],
  ["r", "r"], ["pl", "perl"], ["pm", "perl"],
  ["dart", "dart"], ["ex", "elixir"], ["exs", "elixir"],
  ["graphql", "graphql"], ["gql", "graphql"],
]);

/**
 * 解析文件路径对应的 highlight.js 语言（或 null）。
 * 优先扩展名；无扩展名时回退到完整基名（Makefile / Dockerfile）。
 *
 * @param {string} filePath
 * @returns {string|null}
 */
function resolveLang(filePath) {
  const base = (filePath.split("/").pop() ?? "");
  const dot = base.lastIndexOf(".");
  let key = "";
  if (dot > 0) key = base.slice(dot + 1).toLowerCase();
  else if (dot < 0) key = base.toLowerCase(); // 无扩展名：Makefile / Dockerfile
  return CODE_LANG.get(key) || null;
}

/** 是否走文档（API 渲染）路径。 */
function isDocFile(filePath) {
  if (!filePath) return true; // 默认 README
  const base = (filePath.split("/").pop() ?? "");
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return DOC_EXTS.has(base.slice(dot + 1).toLowerCase());
}

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
 * base 取 raw.githubusercontent.com 的 HEAD 分支 + 文件所在目录，
 * 让 assets/foo.png 这类仓库内相对引用也能解析。
 *
 * 文件目录的作用：markdown 在子目录时（如 readme/README.zh-CN.md），
 * 里面的 ../assets/x.png 是相对文件位置解析的。若 base 只用仓库根
 * （{RAW_BASE}/{owner}/{repo}/HEAD/），../ 会把 HEAD/ 这一层吃掉，
 * 导致分支名丢失 → raw 404。所以 base 必须包含文件所在目录。
 *
 * @param {string} url
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath 文件路径（可为空 → 默认 README 在根目录）
 * @returns {string}
 */
function resolveUrl(url, owner, repo, filePath) {
  const fileDir = filePath ? filePath.slice(0, filePath.lastIndexOf("/") + 1) : "";
  try {
    return new URL(url, `${RAW_BASE}/${owner}/${repo}/HEAD/${fileDir}`).href;
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
 * @param {string} filePath 文件路径（可为空 → 默认 README 在根目录）
 * @returns {HTMLRewriter}
 */
function buildRewriter(owner, repo, filePath) {
  const rewriter = new HTMLRewriter();

  function proxyImgSrc(imgEl) {
    // data-canonical-src 是 camo 代理图对应的真实原始 URL，
    // 优先用它代理（camo 链接有时效、且自带 recompress），
    // 没有再退回 src。
    const canonical = imgEl.getAttribute("data-canonical-src");
    const src = imgEl.getAttribute("src");
    const raw = canonical || src;
    if (!shouldProxy(raw)) return;
    const absolute = resolveUrl(raw, owner, repo, filePath);
    imgEl.setAttribute("src", proxyUrl(absolute));
  }

  function proxyMediaSrc(el) {
    const src = el.getAttribute("src");
    if (!shouldProxy(src)) return;
    el.setAttribute("src", proxyUrl(resolveUrl(src, owner, repo, filePath)));
  }

  // <a>：仅改写相对路径的资源链接为 /proxy/<resolved>，
  // 修复「图片被 <a href="assets/x.png"> 包裹 → 点击解析到不存在的
  // /github/<user>/<repo>/assets/x.png」的问题。
  // 绝对地址的外部链接保持原样（直接跳转）；# 锚点由 shouldProxy 过滤。
  function proxyAnchor(el) {
    const href = el.getAttribute("href");
    if (!shouldProxy(href)) return;
    if (/^https?:\/\//i.test(href.trim())) return;
    el.setAttribute("href", proxyUrl(resolveUrl(href, owner, repo, filePath)));
  }

  rewriter.on("img", { element: proxyImgSrc });
  rewriter.on("video", { element: proxyMediaSrc });
  rewriter.on("source", { element: proxyMediaSrc });
  rewriter.on("a", { element: proxyAnchor });

  return rewriter;
}

/**
 * 获取仓库元数据：owner 头像、star / fork / watching 数量。
 * 与 fetchContent / fetchRawSource 并行发出（Promise.all），不增加往返。
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
 * 注意：仅用于文档路径（README/.md/.rst/.org）；代码文件走 fetchRawSource。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath 文件路径（可为空 → 默认 README）
 * @param {string} [token] 可选的 GITHUB_TOKEN（pat），提升限流配额
 * @returns {{ ok, status, type: "file"|"dir"|"error", html, contentType, listing }}
 */
async function fetchContent(owner, repo, filePath, token) {
  const headers = {
    // 走 raw 而不是 github.html：github.html 会把 img src 转成
    // private-user-images 的 JWT URL（几分钟失效，但 HTML 缓存 5 分钟
    // → 图片死链）。raw 路线下 /markdown/raw 渲染保留干净 URL。
    Accept: "application/vnd.github.raw",
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

  // 文件：raw accept 返回原始 markdown 源码
  if (!contentType.includes("application/json")) {
    const raw = await res.text();
    // 用 markdown-it（lib/markdown.js）渲染成 HTML，代码块由
    // highlight.js 在 Worker 端着色。走 raw 而不是 github.html：
    // github.html 会把 img src 转成 private-user-images 的 JWT URL
    // （几分钟失效，但 HTML 缓存 5 分钟 → 图片死链）。
    const html = renderMarkdown(raw);
    return { ok: true, status: 200, type: "file", html, contentType, listing: [] };
  }

  // 目录：GitHub 对目录返回 JSON 数组
  const data = await res.json();
  if (Array.isArray(data)) {
    return { ok: true, status: 200, type: "dir", html: "", contentType, listing: data };
  }
  // 非数组的 JSON（如二进制文件的 403 错误信息）→ 无法渲染
  return { ok: false, status: res.status, type: "error", html: "", contentType, listing: [] };
}

/**
 * 用 markdown-it 把 raw markdown 渲染成 HTML。
 *
 * markdown-it 实例在首次调用时惰性创建（需要 hljs，由 serveGithub
 * 传入）。代码块通过 markdown-it 的 highlight 选项交给 hljs 着色：
 * 语言被识别 → 返回已着色的 span HTML；未识别 → 返回空串，markdown-it
 * 走默认转义并保留 language-xxx class。
 *
 * @param {string} raw raw markdown 源码
 * @returns {string} 渲染后的 HTML
 */
function renderMarkdown(raw) {
  if (!markdownRenderer) {
    // 退化：hljs 未注入时直接 escape（理论上不会发生，serveGithub 总是传 hljs）
    return `<pre>${escapeHtml(raw)}</pre>`;
  }
  return markdownRenderer(raw);
}

/**
 * 拉取代码文件的 raw 源码（ Worker 端高亮用）。
 *
 * 走 raw.githubusercontent.com/{owner}/{repo}/HEAD/{path}，拿到纯文本源码。
 * 代码文件不该走 GitHub API 的 html accept（会返回 <div class="plain"><pre>
 * 纯文本，无高亮），所以单独拉 raw。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath
 * @returns {{ ok: boolean, status: number, text: string }}
 */
async function fetchRawSource(owner, repo, filePath) {
  const url = `${RAW_BASE}/${owner}/${repo}/HEAD/${filePath}`;
  const res = await fetch(url, {
    headers: {
      Accept: "text/plain, text/*, */*",
      "User-Agent": "x-page-worker (Cloudflare Worker; +https://github.com/)",
    },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return { ok: false, status: res.status, text: "" };
  return { ok: true, status: 200, text: await res.text() };
}

/**
 * Worker 端按需 fetch highlight.js 语言模块源码并缓存。
 *
 * 语言模块 UMD 形态是立即注册的 IIFE：
 *   (()=>{ ...; hljs.registerLanguage("csharp", grammar) })()
 * highlight.mjs 暴露的 highlightWith(value, language, source) 用
 * new Function("hljs", source)(hljs) 在 hljs 作用域里执行它完成注册。
 *
 * @param {string} language highlight.js 语言名
 * @returns {Promise<string|null>} 模块源码；失败返回 null
 */
async function fetchLangModule(language) {
  const cached = LANG_MODULE_CACHE.get(language);
  if (cached) return cached;
  const res = await fetch(`${HLJS_LANG_CDN}/${language}.min.js`, {
    cf: { cacheTtl: 86400, cacheEverything: true }, // 语言模块几乎不变，缓存 24h
  });
  if (!res.ok) return null;
  const src = await res.text();
  LANG_MODULE_CACHE.set(language, src);
  return src;
}

/**
 * Worker 端把源码渲染成着色好的静态 HTML。
 *
 * - 内置语言（highlight.mjs 的 BUILTIN_LANGS）→ 直接 highlightCode。
 * - 其它语言 → 按需 fetch 语言模块再由 highlightWith 注册后高亮。
 * - 超长源码（> CODE_MAX_CHARS）或高亮失败 → 退化为纯文本。
 *
 * @param {string} source 源码原文
 * @param {string} language highlight.js 语言名
 * @param {object} hljs worker.js 传入的 highlight.mjs 命名空间
 * @returns {Promise<{ html: string, plain: boolean }>} colored HTML（已是转义好的 <span class="hljs-xxx"> 片段）
 */
async function renderHighlighted(source, language, hljs) {
  if (source.length > CODE_MAX_CHARS) {
    return { html: escapeHtml(source), plain: true };
  }
  try {
    if (hljs.BUILTIN_LANGS.has(language)) {
      return { html: hljs.highlightCode(source, language), plain: false };
    }
    const mod = await fetchLangModule(language);
    if (mod) return { html: hljs.highlightWith(source, language, mod), plain: false };
    return { html: escapeHtml(source), plain: true };
  } catch (e) {
    return { html: escapeHtml(source), plain: true };
  }
}

/**
 * 渲染文档（README/.md/.rst/.org）内容页的 <header> + 统计条。
 * 文档与代码页共用同一个顶部条，此处提取为纯函数复用。
 *
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath
 * @param {object} meta
 * @returns {string} .gh-topbar 片段
 */
function renderTopbar(owner, repo, filePath, meta) {
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const safePath = escapeHtml(filePath);
  const avatarUrl = meta?.avatarUrl ? proxyUrl(meta.avatarUrl) : "";

  const pathDisplay = filePath
    ? `<a href="https://github.com/${safeOwner}" target="_blank">${safeOwner}</a><span class="gh-sep">/</span><a href="${repoUrl}" target="_blank">${safeRepo}</a><span class="gh-sep">/</span><a href="${repoUrl}/blob/HEAD/${safePath}" target="_blank">${safePath}</a>`
    : `<a href="https://github.com/${safeOwner}" target="_blank">${safeOwner}</a><span class="gh-sep">/</span><a href="${repoUrl}" target="_blank">${safeRepo}</a>`;

  const avatarTag = avatarUrl
    ? `<a href="https://github.com/${safeOwner}" target="_blank"><img src="${avatarUrl}" class="gh-avatar"></a>`
    : `<div class="gh-avatar gh-avatar-ph"></div>`;

  return `<div class="gh-topbar">
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
    </div>`;
}

/**
 * 把 README 文档的 HTML 片断包裹为完整的、自包含的页面。
 *
 * 复用了原来的 .gh-topbar 布局；正文用 water.css 兜底排版；代码块 /
 * 表格 / 图片约束在容器宽度内。注入 highlight.js 主题 CSS（github +
 * github-dark，dark 用 @media (prefers-color-scheme: dark) 包裹）。
 *
 * @param {string} readmeHtml 已改写资源路径的 README body
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath 文件路径（空串 = 默认 README）
 * @param {string} meta 元数据 { avatarUrl, stars, forks, watching }
 * @param {string} waterCss water.css 源码字符串
 * @param {string} themeCss highlight.js 主题 CSS（含 dark @media）
 * @returns {string} 完整 HTML 文档
 */
function wrapDocPage(readmeHtml, owner, repo, filePath, meta, waterCss, themeCss) {
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const safePath = escapeHtml(filePath);
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
    .markdown-body a.anchor, #readme a.anchor { display: none; }
    .markdown-body img, #readme img { max-width: 100%; height: auto; box-sizing: border-box; }
    .markdown-body video, #readme video { max-width: 100%; }
    .markdown-body pre, #readme pre { overflow-x: auto; }
    .markdown-body table, #readme table { max-width: 100%; display: block; overflow-x: auto; }
    /* highlight.js 主题（hljs-*）：代码块着色，light + dark 自动切换 */
    ${themeCss}
    </style>
</head>
<body>
    ${renderTopbar(owner, repo, filePath, meta)}
    <div id="readme" class="markdown-body">
        ${readmeHtml}
    </div>
</body>
</html>`;
}

/**
 * 把代码文件渲染成完整的自包含页面（Worker 端已着色，浏览器零 JS）。
 *
 * 顶部复用 .gh-topbar 布局；正文是 <pre><code> 包着 hljs.highlight()
 * 产出的静态 <span class="hljs-xxx"> 着色片段。主题 CSS（github + github-dark，
 * dark 用 @media prefers-color-scheme: dark 包裹）内联到 <style>。
 *
 * @param {string} colored htl highlight() 产出的着色 HTML（已含 <span class="hljs-xxx">）
 * @param {string} language highlight.js 语言名（用于 class="language-xxx" 标记）
 * @param {boolean} plain 是否退化为纯文本（超长 / 失败）
 * @param {string} owner
 * @param {string} repo
 * @param {string} filePath
 * @param {string} meta
 * @param {string} waterCss
 * @param {string} themeCss github + github-dark 主题（dark 已用 @media 包裹）
 * @returns {string} 完整 HTML 文档
 */
function wrapCodePage(colored, language, plain, owner, repo, filePath, meta, waterCss, themeCss) {
  const safeOwner = escapeHtml(owner);
  const safeRepo = escapeHtml(repo);
  const safePath = escapeHtml(filePath);
  const safeLang = escapeHtml(language);
  // 着色成功的代码块标上 language-xxx class（便于用户复制 / 主题样式），纯文本退化解不标。
  const codeClass = plain ? "" : ` class="language-${safeLang}"`;
  return `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${safeOwner}/${safeRepo} · ${safePath}</title>
    <style>
    ${waterCss}
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
    /* 代码块容器：字体 + 边框 + 横向滚动 */
    .gh-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
    .gh-code pre { margin: 0; line-height: 1.5; border: 1px solid var(--border); border-radius: 6px; overflow-x: auto; white-space: pre; tab-size: 4; }
    .gh-code code { display: block; }
    /* highlight.js 主题（github light + github-dark）：prefers-color-scheme 自动切换明暗 */
    ${themeCss}
    </style>
</head>
<body>
    ${renderTopbar(owner, repo, filePath, meta)}
    <div class="gh-code"><pre><code${codeClass}>${colored}</code></pre></div>
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
    .gh-stat-hover:hover { text-decoration:none; background:var(--background); }
    .gh-stat .gh-stat-count { font-weight:700; }
    .gh-stat .gh-stat-icon { font-size:0.95em; }
    /* 目录列表 */
    .gh-dir-parent { display:inline-block; margin-bottom:10px; padding:4px 10px; border:1px solid var(--border); border-radius:6px; color:var(--links); text-decoration:none; font-size:0.9em; }
    .gh-dir-parent:hover { text-decoration:none; text-decoration:underline; }
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
 *   /github/<user>/<repo>/<path>     → 指定文件（文档/代码）或目录（文件列表）
 *
 * @param {Request} _request 入站请求（本路由仅从路径取参数，未使用 request 体）
 * @param {Object} env wrangler 注入的环境变量（含可选 GITHUB_TOKEN）
 * @param {string} cleanPath 去首斜杠 + decode 后的路径，如 "github/iOfficeAI/OfficeCLI/npm/package.json"
 * @param {string} waterCss water.css 源码字符串
 * @param {object} hljs highlight.mjs 命名空间 { highlightCode, highlightWith, BUILTIN_LANGS, HLJS_THEME_CSS }
 * @returns {Response}
 */
export async function serveGithub(_request, env, cleanPath, waterCss, hljs) {
  // 惰性创建 markdown 渲染器（首次请求时绑定 hljs）。
  // 模块级变量，同 isolate 内跨请求复用。
  if (!markdownRenderer && hljs) {
    markdownRenderer = createMarkdownRenderer(hljs);
  }

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

  // 文件类型分流：
  //   - 代码文件（含扩展名映射到 highlight.js 语言）→ 拉 raw 源码，Worker 端高亮。
  //   - 文档/其它文件 → GitHub API 渲染（README/.md/.rst/.org 着色，目录→列表）。
  const lang = resolveLang(filePath);

  if (lang) {
    // 代码文件路径：raw 源码 + 仓库元数据并行请求。
    const [raw, meta] = await Promise.all([
      fetchRawSource(owner, repo, filePath),
      fetchRepoMeta(owner, repo, token),
    ]);
    if (!raw.ok) {
      const msg = raw.status === 404
        ? `File not found: ${filePath} (404)`
        : raw.status === 403
        ? "GitHub rate limit exceeded (403) — set GITHUB_TOKEN to raise the limit"
        : `GitHub raw fetch error (${raw.status})`;
      return new Response(errorPage(owner, repo, filePath, msg), {
        status: raw.status === 404 ? 404 : 502,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    const { html: colored, plain } = await renderHighlighted(raw.text, lang, hljs);
    const page = wrapCodePage(colored, lang, plain, owner, repo, filePath, meta, waterCss, hljs.HLJS_THEME_CSS);
    return new Response(page, {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300" },
    });
  }

  // 文档 / 其它文件路径：GitHub Contents API（含目录检测）。
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

  // 文件（文档 / 默认 README）→ markdown-it 已着色 + HTMLRewriter 代理图片。
  const rewriter = buildRewriter(owner, repo, filePath);

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

  // 文档路径统一用 highlight.js 主题（代码块已在 Worker 端由 markdown-it 着色）
  const page = wrapDocPage(bodyHtml, owner, repo, filePath, meta, waterCss, hljs.HLJS_THEME_CSS);
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
