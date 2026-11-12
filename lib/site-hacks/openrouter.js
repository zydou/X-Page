/**
 * lib/site-hacks/openrouter.js
 * ============================================================
 * openrouter.ai 站点专属 hack。
 *
 * 问题：openrouter.ai 页面内联了一段「反镜像」脚本，它在客户端
 * 判断 window.location.hostname 是否在自家白名单内，不在就用
 * location.replace(`https://openrouter.ai${pathname}${search}${hash}`)
 * 把整个页面强制跳回原站。经 /html/ 代理后页面跑在本 Worker 域名下，
 * 不在白名单里，于是浏览器一加载就被赶走，只留下一屏骨架占位。
 *
 *   <script>(function({location:a,navigator:b},c){
 *     let d=a.hostname.toLowerCase();
 *     if((!c(d)||d.endsWith(".vercel.app"))&&!d.endsWith(".translate.goog")
 *        &&"web.archive.org"!==d){
 *       try{b.sendBeacon?.("/api/frontend/v1/mirror-host-report",d)}catch{}
 *       a.replace(`https://openrouter.ai${a.pathname}${a.search}${a.hash}`)
 *     }
 *   })(window, function(a){...白名单...});</script>
 *
 * 同时页面带 <link rel="canonical" href="https://openrouter.ai/...">，
 * 指向原站绝对地址，一并移除以免误导客户端路由。
 *
 * 关键取舍——只动「可执行的那一份」，绝不碰 Next.js flight payload：
 *   这段反镜像代码在页面里出现多次，但只有两种形态：
 *     1. 一段独立的 <script>(function({location:a,...})...</script>，
 *        里面是「未转义」的 mirror-host-report —— 这才是真正会执行、
 *        会 location.replace 跳转的那一份，必须中和。
 *     2. Next.js 把它作为 RSC 数据塞进 self.__next_f.push(...) 的
 *        flight payload，里面是 \"mirror-host-report\" 这种「已转义」
 *        的字符串字面量 —— 那只是数据，不是可执行检查，而且正是它
 *        在客户端 hydration 渲染出正文。删了它页面就永远停在骨架屏。
 *   所以下面的正则特意锚定 <script>(function({location:a,navigator:b},c)
 *   这个「未转义」的开头，只会命中形态 1；形态 2 的 script 内容以
 *   self.__next_f.push 开头且已转义，天然不匹配，得以保留。
 *
 * 为什么用整篇字符串后处理而非 HTMLRewriter 的 text 处理器：
 *   HTMLRewriter 把 script 正文切成多个 text chunk，"mirror-host-report"
 *   可能正好跨在 chunk 边界导致 includes() 落空；且内容一旦流式输出
 *   就无法 remove()/replace() 撤回。在缓冲好的完整 HTML 上整段正则替换
 *   对这两点都免疫（实测这段脚本是 550 字符的单个连续块，无换行）。
 * ============================================================
 */

/**
 * 反镜像独立脚本的正则：锚定未转义的 IIFE 开头，整段吞到第一个 </script>。
 * 非贪婪 [\s\S]*? 保证不会越过该 script 误吞后面的 flight payload。
 */
const MIRROR_SCRIPT_RE =
  /<script>\(function\(\{location:a,navigator:b\},c\)[\s\S]*?<\/script>/g;

/** 中和后替换成的无害占位，保持 <script> 元素存在但不执行任何逻辑。 */
const NEUTRALIZED = "<script>/* mirror-check neutralized by x-page */</script>";

/** 指向原站的 canonical 链接（自闭合，属性顺序固定，实测唯一形态）。 */
const CANONICAL_RE = /<link\s+rel="canonical"[^>]*>/gi;

/**
 * 判断该 hack 是否适用于给定目标 host。
 *
 * @param {string} host 被代理页的 hostname（如 "openrouter.ai"）
 * @returns {boolean}
 */
export function matches(host) {
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

/**
 * 对完整 HTML 做精确中和：干掉可执行的反镜像脚本 + 指向原站的 canonical。
 *
 * 在缓冲好的整篇 HTML 字符串上运行，天然对 HTMLRewriter 的 chunk 切分
 * 免疫；正则锚定未转义开头，保证只命中真正会跳转的那一份脚本。
 *
 * @param {string} html 缓冲好的完整 HTML
 * @returns {string} 中和后的 HTML
 */
export function sanitize(html) {
  return html.replace(MIRROR_SCRIPT_RE, NEUTRALIZED).replace(CANONICAL_RE, "");
}
