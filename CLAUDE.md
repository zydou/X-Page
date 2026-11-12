# Repository Guidelines

Cloudflare Worker that provides four services behind one hostname.
Multi-file ES Module: `worker.js` is the router, each service lives in `routes/`.

## Project Structure

```text
x-page/
├── worker.js                # entry point: imports assets + dispatches routes
├── routes/
│   ├── index.js             # / → 302 redirect to GitHub repo
│   ├── proxy.js             # /proxy/<url> → generic media proxy
│   ├── video.js             # /vid/<url> and /vid/d/<url> → Artplayer HTML
│   ├── image.js             # /img/<url> and /img/d/<url> → image viewer HTML
│   ├── html.js              # /html/<url> → HTML fetch + rewrite
│   ├── wechat.js            # /wechat/<url> → WeChat article HTML
│   ├── tweet.js             # /<user>/status/<id>[?mode=][&lang=] → tweet HTML
│   ├── github.js            # /github/<user>/<repo>[/<path>] → README/file/dir HTML
│   └── webhook.js           # POST /webhook → Telegram bot（X-Page 链接转换）
├── lib/
│   ├── utils.js             # shared pure functions (proxyUrl, formatDate, parseMedia, etc.)
│   ├── markdown.js          # markdown → HTML (markdown-it + highlight.js), used by /github/
│   ├── to-markdown.js       # HTML → markdown (Workers AI toMarkdown), used by /html/ + /wechat/
│   ├── thread.js            # tweet 自推链补全 + 墓碑判定 + 后代筛选（纯函数，会话数据经 io 注入）
│   ├── site-hacks/          # 站点专属 hack：中和个别站点的反镜像跳转 / 污染渲染逻辑
│   │   ├── index.js         # 注册表：resolveSiteHack(host) + applySiteHack(html, hack)
│   │   └── openrouter.js    # openrouter.ai：中和反镜像 location.replace + 去掉原站 canonical
│   └── bot/                 # Telegram bot helpers（仅 webhook 路由使用）
│       ├── matcher.js       # 纯函数：链接识别 + X-Page 链接生成
│       ├── telegram.js      # Telegram Bot API 客户端
│       └── media.js         # 媒体下载 → 图床上传
├── assets/
│   ├── twitter.css          # tweet styles (trimmed water subset + twitter rules), served at /assets/
│   └── github.css           # github styles (trimmed water subset + hljs theme + .gh-*), served at /assets/
├── wrangler.toml            # service config, env vars, observability, Text module rules
├── wrangler.dev.toml        # debug-worker config (x-dev)
├── build.sh                 # CI/dev build: fetch + build remote JS assets
├── artplayer.mjs            # CI-generated ESM string from artplayer.js (built by build.sh)
├── markdown-it.mjs          # CI-built markdown-it bundle (Worker-side SSR only)
├── highlight.mjs            # CI-built highlight.js bundle (Worker-side SSR only)
├── README.md                # end-user-facing docs (Chinese)
└── .github/workflows/deploy.yaml
```

## Routing

| Path                                    | Service |
| --------------------------------------- | ------- |
| `/<user>/status/<id>[?mode=m][&lang=l]` | Tweet → standalone HTML; `?mode=self` / `quote` / `thread` / `all`（缺省即 `all`，全部推文）；`?lang=` 覆盖 `TWITTER_LANG`，R2 key 带语言维度（`tweet/<id>.<lang>.json`） |
| `/vid/<raw-url>`                        | Video → player HTML (proxied, Range passthrough) |
| `/vid/d/<raw-url>`                      | Video → player HTML (direct, no proxy) |
| `/img/<raw-url>`                        | Image → adaptive HTML (strips `Content-Disposition: attachment`) |
| `/img/d/<raw-url>`                      | Image → adaptive HTML (direct) |
| `/html/<raw-url>`                       | HTML fetch + rewrite (custom UA, proxy media, absolutize `<a>` hrefs); `Accept: text/markdown` → markdown |
| `/r2-html/<raw-url>`                    | Same as `/html/` + R2 persistent cache for the HTML view (`html/<target>`, permanent, no refresh); `Accept: text/markdown` → markdown (cached under `md/html/<target>`, shared with `/html/`) |
| `/wechat/<raw-url>`                     | WeChat article fetch (title links back to original); `Accept: text/markdown` → markdown |
| `/proxy/<raw-url>`                      | Generic passthrough proxy; rewrites JS/CSS relative URLs |
| `/github/<user>/<repo>[/<path>]`        | GitHub README or arbitrary file → rendered HTML; directory → file listing (media proxied via `/proxy/`) |
| `/assets/<name>`                        | Externalized browser CSS/JS (`twitter.css` / `github.css` / `artplayer.js`), `Cache-Control: immutable` 1 年 |
| `/webhook`                              | Telegram bot webhook（POST，校验 `X-Telegram-Bot-Api-Secret-Token`；其余请求 403） |
| `/`                                     | 302 redirect to the GitHub repo |

> URL is appended raw — the browser handles necessary encoding automatically. Only encode (`encodeURIComponent`) when the URL contains special characters (`?`, `#`, space, non-ASCII).

Route priority in `worker.js`: root → favicon → `/vid/` → `/img/` → `/html/` → `/r2-html/` → `/wechat/` → `/proxy/` → `/assets/` → `/github/` → tweet (fallback) → 404.

### /html/ rewrite rules

The `/html/` route (`routes/html.js`) fetches the target page and rewrites it with HTMLRewriter before returning:

- **`<img>` / `<video>` / `<audio>` / `<source>` / `<embed>` / `<object>` / `<iframe>` / `<track>`** —
  rewrite `src`/`data-src`/`srcset`/`poster`/`data` to `/proxy/<encoded>` so media loads through the Worker (bypassing hotlink protection)
- **`<script>` / `<link>`** — only proxy absolute CDN URLs; skip relative paths (their internal relative imports break when loaded from the worker domain)
- **`<a>`** — only resolve relative `href` to an absolute original URL; no `/html/` prefix, so links go straight to the origin site (and appear as original URLs in the markdown variant)
- **`<style>` blocks and inline `style` attributes** — rewrite `url(...)` references to proxy paths

The `/proxy/` route (`routes/proxy.js`) additionally rewrites JS/CSS **content**: relative `import("./...")`, `from"./..."`, and `url(...")` references are converted to absolute proxy paths,
so Vite-style chunk loading works through the proxy.

### Site-specific hacks (`lib/site-hacks/`)

Some proxied sites run client-side logic a generic rewriter can't fix.
For example, openrouter.ai ships an inline "anti-mirror" script that calls `location.replace()`.
It bounces the browser back to the real origin whenever the hostname isn't whitelisted, leaving only a skeleton.
`lib/site-hacks/` holds one file per site, each exporting:

- `matches(host)` — whether the hack applies to this target hostname
- `sanitize(html)` — exact neutralization over the **fully-buffered** HTML string

`routes/html.js` resolves the hack by hostname, then applies `sanitize` after the HTMLRewriter pass.
It runs in all three buffered paths: markdown, main HTML, and the rewrite-failure fallback.
To add a site, create a file and register one entry in `HACKS`.

Why buffer the whole string instead of using an HTMLRewriter `text` handler?
HTMLRewriter streams a script body as multiple chunks, so a marker can straddle a chunk boundary and `includes()` misses it.
Already-streamed content also can't be retracted with `remove()`.
The buffered string is immune to both.
It also lets a hack target only the *executable* copy of a script.
That matters for Next.js, whose flight payload holds escaped data copies of the same script that hydration needs.

### `Accept: text/markdown` (tweet / html / wechat)

These three routes return `text/markdown` when the request's `Accept` header mentions `text/markdown`; otherwise they return HTML unchanged.
**Every branch sets `Vary: Accept`** — without it the edge would serve a cached HTML response to a markdown client.

Responses also carry `x-markdown-tokens` (CJK-aware estimate from `estimateTokens()` in `lib/utils.js`).

The tweet route renders markdown from fxtwitter data itself.
`/html/` and `/wechat/` instead go through Workers AI `toMarkdown` (`lib/to-markdown.js`), with three constraints:

- **Always pass the fetched HTML string, never let the converter fetch the URL.**
  `/html/` and `/wechat/` depend on a custom User-Agent (default iOS WeChat) plus Referer to retrieve bodies; only the Worker can do that.
  The converter receives the already-fetched HTML as a blob.
- **Relative URLs are resolved by injecting a `<base href>` tag.**
  After `buildRewriter()` every `<a href>` is an absolute original URL and every media attribute is `/proxy/<abs>`, so the only page-relative paths left are the `/proxy/` ones; pointing the base at this Worker's origin absolutises them.
  `conversionOptions.html.hostname` is deliberately *not* used — it works over REST but is silently ignored through the Workers AI binding (verified on x-dev: 78 links emitted relative).
  The converter still drops `srcset` and `data-src`-only images, which is why `buildRewriter()`'s srcset/`data-src`→`src` backfill must stay.
- **Results must be cached in R2** under `md/<ns>/<target>`, where `<ns>` is `html` (shared by `/html/` and `/r2-html/`, identical output) or `wechat` (`/wechat/`, transform-trimmed output).
  HTML conversion is deterministic and model-free (0 Neurons), but a single page takes 130–330 ms and ~8% of requests show a 48–100 s tail, so each URL is converted at most once for its lifetime.
  `?refresh=1` forces a re-conversion.
  Failures return `502`/`406` and are never written to R2.
  Input over ~4 MiB is rejected fast by `MAX_INPUT_CHARS` — the service otherwise hangs ~41 s before erroring.

`/wechat/` additionally strips two blocks of client-injected DOM off the **markdown variant only**: `toMarkdown` does not honour `display:none`, so elements WeChat renders invisible still get extracted.
`routes/wechat.js` removes

- the footer chrome, by truncating at `<div id="js_tags_preview_toast">` — the anchor for the
  "预览时标签不可点" toast, present exactly once per document, with the bottom toolbar (修改于 /
  不喜欢), QR-code dialogs and share panel after it
- the novel-reader promo card, by slicing from `<div id="js_novel_card">` up to the `#js_content` opening tag — the card's closing tag sits directly before `#js_content`, so no div-depth counting is needed.
  The byline (`#meta_content`, `#js_profile_card`) sits before the card and is kept

Both anchors are WeChat client JS-hook ids rather than text content — ids are stable, copy is not.
The HTML variant is left intact: those divs carry `display:none` and are invisible there anyway, and trimming would change the route's faithful-rendering behaviour.
This is why `serveHtml`'s `transform` hook takes an `isMarkdown` flag.

## Externalized Assets (`/assets/` routes)

Browser-served CSS/JS are external (not inlined) so that a Feishu doc with dozens of iframes shares one copy via browser HTTP cache.
Worker imports them via the `Text` module rule and serves at `/assets/<name>` with `Cache-Control: public, max-age=31556952, immutable`.

| Asset                | Source                                                 | Served at              | Used by routes |
| -------------------- | ------------------------------------------------------ | ---------------------- | -------------- |
| `assets/twitter.css` | repo (trimmed water.css subset + twitter rules)        | `/assets/twitter.css`  | tweet          |
| `assets/github.css`  | repo (trimmed water.css subset + hljs theme + `.gh-*`) | `/assets/github.css`   | github         |
| `artplayer.mjs`      | CI-generated from `artplayer.js` (jsdelivr)            | `/assets/artplayer.js` | video          |

The trimmed "water" subset in `assets/*.css` keeps only the box model +
typography rules actually emitted by the routes (`:root` vars, `h1-h6/p/a/ul/li/
blockquote/table/pre/code/hr/img/video/strong`, scrollbars); all form controls
(`button/input/select/textarea`), `details/summary/dialog`, `label/fieldset`,
`@media print`, and `mailto:/sms:/tel:` decoration are removed.

`artplayer.mjs` is built as an ESM default-exported string (`export default "<JSON-escaped source>"`) to avoid backticks/`${` breaking template literals.
`markdown-it.mjs` and `highlight.mjs` remain Worker-side only (SSR rendering) and are not served to the browser.

### CI Pipeline (`.github/workflows/deploy.yaml`)

1. `npx wrangler deploy` — Wrangler runs the `[build]` command (`sh build.sh`) first, which downloads and builds all remote assets (artplayer, markdown-it, highlight.js), then deploys.
   `assets/*.css` are committed to the repo and not rebuilt.
2. Re-enables the Worker Cache runtime setting via API (Wrangler resets it on each deploy).

Trigger paths: push to `worker.js`, `routes/**`, `lib/**`, `assets/**`, `wrangler.toml`, `build.sh`, `deploy.yaml`; or `workflow_dispatch`.

## Vars

| Var                     | Purpose |
| ----------------------- | ------- |
| `TIMEZONE`              | Tweet timestamp display timezone |
| `TWITTER_LANG`          | BCP-47 language for tweet translation; blank = original. `?lang=` on the URL overrides it |
| `TWITTER_PREWARM_LANGS` | Comma-separated BCP-47 list the Telegram bot prewarms (`tweet/<id>.<lang>.json` per language); blank = fall back to `TWITTER_LANG`. Bot prewarm only, does not affect `serveTweet` default rendering |
| `GITHUB_TOKEN`          | Optional GitHub PAT for `/github/` route to raise the API rate limit (60/h → 5000/h); blank = unauthenticated (public repos only) |
| `UA`                    | User-Agent override for `/html/` fetches; defaults to iOS WeChat UA |

Bindings: `env.TWEETS` → R2 bucket `x-page` / `x-page-dev` (keys `tweet/`, `wechat/`, `md/`); `env.AI` → Workers AI, used only for the markdown conversion.
`toMarkdown()` on HTML is deterministic and model-free, so it consumes 0 Neurons and never touches the free plan's 10,000 Neurons/day pool (verified on this free account, 2026-10).
Note the markdown conversion feature carries a **Beta** badge in the Cloudflare docs nav — Workers AI itself is GA.

Telegram bot secrets (`BOT_TOKEN`, `WEBHOOK_SECRET`, `IMGUR_CLIENTID`, `IMGBB_API_KEY`, `X_PAGE_BASE`, `ALLOWED_CHATS`) are set via `wrangler secret put` and read by the `/webhook` route (`routes/webhook.js`).
See `README.md` → Telegram 转换 Bot.

### Local Development

```bash
# Build remote assets (JS only), then start dev server
sh build.sh
npx wrangler dev
```

### Deploy & Test

**Two-stage deploy: debug worker first, then production.**

1. **Debug stage** — create a separate `x-dev` Worker for testing changes:

   ```bash
   # Copy wrangler.toml → wrangler.dev.toml, change name to "x-dev" and route to a dev hostname
   npx wrangler deploy --config wrangler.dev.toml
   ```

   Verify every route on the dev hostname before touching production.

2. **Production stage** — only after dev passes:

   ```bash
   npx wrangler deploy
   ```

**Do NOT wait for the GitHub Actions `Deploy` workflow to pass** — it is frequently slow / queued for minutes and is not a reliable gate.
Deploy via Wrangler directly for both stages.

```bash
# Debug on x-dev first
npx wrangler deploy --config wrangler.dev.toml

# Then deploy to production
npx wrangler deploy

# Verify each route against the live edge:
curl https://<host>/html/https%3A%2F%2Fexample.com/
curl https://<host>/wechat/https%3A%2F%2Fmp.weixin.qq.com%2Fs%2F...
curl -H "Range: bytes=0-..." https://<host>/proxy/<url>   # range passthrough
```

Local hot-reload dev (no deploy) for quick iteration:

```bash
npx wrangler dev
```

## Style Conventions

- Vanilla ES module JS.
  No TypeScript, no bundler, no linter.
- 2-space indent.
  `worker.js` is the router only; services live in `routes/`, shared helpers in `lib/`.
- User-supplied URLs are appended raw at the edge.
  Only `encodeURIComponent` when the URL contains `?`, `#`, space, or non-ASCII.
  When unsure, always encoding is safe.
  One-off tool: [meyerweb dencoder](https://meyerweb.com/eric/tools/dencoder/).
- All consumer-supplied assets must be inlined into templates; never reference an external origin in rendered HTML.

## Gotchas

### `wrangler.toml` module rules 必须用 `[[rules]]` 数组表头形式

wrangler 4.x 的 module rules 写法：

```toml
# ✅ 正确：数组表头形式
[[rules]]
type = "Text"
globs = ["**/*.css"]
fallthrough = true

# ❌ 错误：裸字段形式（prod 当前若没 [[r2_buckets]] 等其他 [[array]]
# 块能侥幸工作，但任何时候加 [[r2_buckets]]/[[kv_namespaces]] 等块，
# 裸 rules 字段会被 TOML 吞进最近的 [[array]] 项里）
rules = [{ type = "Text", globs = ["**/*.css"], fallthrough = true }]
```

**踩坑症状**：wrangler 部署时打印 `Unexpected fields found in r2_buckets[0] field: "rules"`，CSS/其他 Text 模块没被打包，Worker 里 `import TWITTER_CSS from "./assets/twitter.css"` 拿到的是空对象，`/assets/` 返回的 CSS 直接渲染成 `[object Object]` 字符串 —— 页面样式完全丢掉。

**为什么裸形式有时能用**：TOML 规定紧跟 `[[array]]` 项后、未被更上一级 `[table]` 切分前，裸字段都属于那个数组项。
当 `wrangler.toml` 只有一个 `rules = [...]` 而没有其他 `[[xxx]]` 块时，它属于顶层 worker-config 表，能正常工作。
**一旦加上 `[[r2_buckets]]` 等块且顺序在 rules 之前/之后无 `[table]` 切分，rules 就被吞掉**。

**修复**：所有 wrangler config（prod + dev）一律用 `[[rules]]` 数组表头形式，并把 `[[rules]]` 放在其他 `[[array]]` 块之前。

**验证手段**：部署后 `curl` 任意一条路由，看 HTML head 的 `<style>` 标签里是真实 CSS 还是 `[object Object]`。

## Testing

No automated suite.
Validate manually: `npx wrangler dev` then curl/navigate each route prefix; use `curl -H "Range: bytes=0-..."` to exercise range passthrough on `/vid/` and `/proxy/`.

## Commit & PRs

- Imperative-mood messages: `add image proxy route`, `fix: strip content-disposition on proxy`.
- One concern per PR.
  If you touch routing, include a curl example for each affected prefix.

<!-- rumdl-disable MD013 -->
<!-- OPENWIKI:START -->

## OpenWiki

This repository has a generated `openwiki/` evidence index. It is optional just-in-time context, not required startup reading.

- Do not enumerate, preload, or search wikis at task start. Use retrieval when the user asks for it, when unfamiliar architecture or dependency behavior materially affects the task, or when source inspection leaves an important uncertainty. Stop once the question is grounded.
- When those conditions apply and OpenWiki retrieval tools are available, use `openwiki_search` for just-in-time context and `openwiki_read` for the relevant complete sections. If search returns `workspace_required`, ask which listed workspace to use and retry with its ID.
- Use `openwiki_list_workspaces` or `openwiki_list_wikis` when workspace membership itself needs to be discovered.
- If the retrieval tools are unavailable, read `openwiki/quickstart.md` and follow its links to the relevant pages.
- Treat source code and tests as authoritative. A brief's unknowns and review items are verification gaps, not automatic requirements.
- Prefer the narrowest quiet validation that proves the changed behavior. Preserve complete failure output.

Use the repository's documented maintenance process to refresh generated pages after source changes. Check its configuration and completed runs before relying on automatic updates. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
<!-- rumdl-enable MD013 -->

## OpenWiki 更新时机

OpenWiki 是带 git 基线的证据索引，每页 frontmatter 的 `sources` 声明了它依赖的源文件。

判断是否需要更新时，以各页 `sources` 为准，而不是看有没有新 commit。

- 需要更新：改动了某页 `sources` 中的源文件，并且改变了该页描述的行为，例如路由、R2 key 与生命周期、绑定、vars、secrets、bot 回复选项、Markdown 管线或站点 hack 注册表。
- 也需要更新：只调整了这些源文件的位置（如注释、插入代码），导致页面中的行号引用或 claim 证据失效。
- 不需要更新：只改动了未被任何页面声明为 source 的文件，例如 README.md、CLAUDE.md、wrangler.dev.toml，或只做与行为无关的格式调整。
- 不必每个 commit 都更新：攒一批行为改动后统一刷新，可以减少 claim 的核对量。

执行方式：

- 先运行 `openwiki_begin`（mode update）。返回 `noop` 即无需更新；否则依据返回的 `changedPaths` 与 `claimIssues` 执行。
- 按生命周期推进：`openwiki_submit_plan` → 循环 `openwiki_next_page`、修改页面、`openwiki_submit_page` → `openwiki_finish`。每条 stale claim 都必须明确 confirm、revise 或 retract。
- 不手改生成页面，页面内容只通过上述生命周期修改。
- OpenWiki 产物单独提交，使用 `docs(openwiki): ...`，不与代码改动混在同一个 commit 中。
- 不手改 `OPENWIKI:START` 与 `OPENWIKI:END` 之间的内容，也不删除其外层的 rumdl 区域标记。
