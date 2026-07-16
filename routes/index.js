/**
 * routes/index.js
 * ============================================================
 * 根路由 "/" 使用说明页。
 *
 * 所有特性在此统一列出：推文播放器 / 图片代理 / 视频代理 / 通用代理。
 * host 参数用于生成用户能直接点击体验的示例链接。
 * ============================================================

/**
 * 根路径 "/" 的主入口：返回使用说明页。
 *
 * 说明页是静态模板，所有内容一次性输出；不做异步 I/O，
 * 因此 Response 直接可用，无需 await。
 *
 * @param {string} host 当前 Worker 的 Host（如 x.example.com）
 * @returns {Response} 自包含的使用说明 HTML
 */
export function indexHtml(host) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>X-Page</title></head><body style="font-family:sans-serif;max-width:600px;margin:40px auto;padding:0 16px">
<h2>X-Page Worker</h2>

<h3>🐦 X / Twitter 推文 → HTML</h3>
<ul>
<li>支持推文、Thread、Article；自动展开链接</li>
<li>内置媒体代理，无需外部代理即可在受限地区访问推内图片/视频</li>
</ul>
<p>格式：https://${host}/&lt;username&gt;/status/&lt;tweet_id&gt;</p>
<p>原始：<a href="https://x.com/SpaceX/status/2072464558732824680">https://<mark>x.com</mark>/SpaceX/status/2072464558732824680</a></p>
<p>转换：<a href="https://${host}/SpaceX/status/2072464558732824680">https://<mark>${host}</mark>/SpaceX/status/2072464558732824680</a></p>

<h3>🎬 视频代理</h3>
<ul>
<li>通过 Worker 代理视频流，绕过防盗链与跨域限制</li>
<li>1 年 CDN 缓存；完整透传 <code>Range</code> 请求头，支持拖拽播放</li>
</ul>
<p>直连模式：https://${host}/vid/d/&lt;VIDEO_URL&gt;</p>
<p>格式：https://${host}/vid/&lt;VIDEO_URL&gt;</p>
<p>示例：<a href="https://${host}/vid/https://lorem.video/720p">https://${host}/vid/https://lorem.video/720p</a></p>

<h3>🖼️ 图片代理</h3>
<ul>
<li>剥离 <code>Content-Disposition: attachment</code>，强制以 <code>inline</code> 显示</li>
<li>自适应缩放，支持飞书云文档等 16:9 预览窗格内完整查看</li>
<li>1 年 CDN 缓存</li>
</ul>
<p>格式：https://${host}/img/&lt;IMAGE_URL&gt;</p>
<p>直连模式：https://${host}/img/d/&lt;IMAGE_URL&gt;</p>

<h3>🔗 通用媒体代理</h3>
<p>直接透传任意 http(s):// 资源，附带 CORS、长缓存。</p>
<p>格式：https://${host}/proxy/&lt;URL&gt;</p>
<p>示例：<a href="https://${host}/proxy/https://httpbin.org/json">https://${host}/proxy/https://httpbin.org/json</a></p>

<h3>🐙 GitHub 仓库</h3>
<ul>
<li>通过 GitHub API 获取仓库 README 的预渲染 HTML</li>
<li>图片/视频等媒体经 Worker 内部 <code>/proxy/</code> 代理加载，绕过跨域/防盗链</li>
</ul>
<p>格式：https://${host}/github/&lt;user&gt;/&lt;repo&gt;</p>
<p>示例：<a href="https://${host}/github/astral-sh/uv">https://${host}/github/astral-sh/uv</a></p>

<h3>📄 HTML 代理</h3>
<ul>
<li>抓取任意网页并以 HTML 返回，绕过第三方平台直连被拒的问题</li>
<li>图片/视频等媒体经 Worker 代理加载，绕过防盗链</li>
<li>页面内 <code>&lt;a&gt;</code> 链接改写为 <code>/html/&lt;url&gt;</code>，导航不脱离代理体系</li>
</ul>
<p>格式：https://${host}/html/&lt;URL&gt;</p>
<p>示例：<a href="https://${host}/html/https://example.com/">https://${host}/html/https://example.com/</a></p>

<h3>💬 微信公众号文章</h3>
<ul>
<li>与 HTML 代理共享资源代理能力，专为微信公众号文章定制</li>
<li>使用微信 <code>UA</code> 绕过微信公众号等对白名单的限制</li>
<li>文章标题自动包裹 <code>&lt;a&gt;</code> 链接回原文，在飞书等嵌入环境里点击标题即可跳转阅读</li>
</ul>
<p>格式：https://${host}/wechat/&lt;URL&gt;</p>
<p>示例：<a href="https://${host}/wechat/https://mp.weixin.qq.com/s/Y90KsMk2AkIi7iWCb7aSvA/">https://${host}/wechat/https://mp.weixin.qq.com/s/Y90KsMk2AkIi7iWCb7aSvA/</a></p>

<h3>⚠️ URL编码提示</h3>
<p>URL 里有 <code>?</code> <code>#</code> 空格、中文等特殊字符时，需要先 <a href="https://meyerweb.com/eric/tools/dencoder/">URL编码</a></p>
<p>例如：<a href="https://${host}/proxy/https%3A%2F%2Fpostman-echo.com%2Fget%3Ffoo%3Dbar">https://${host}/proxy/https%3A%2F%2Fpostman-echo.com%2Fget%3Ffoo%3Dbar</a></p>
</body></html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );
}
