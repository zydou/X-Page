# Repository Guidelines

Cloudflare Worker that provides four services behind one hostname.
Multi-file ES Module: `worker.js` is the router, each service lives in `routes/`.

## Project Structure

```text
x-page/
├── worker.js                # entry point: imports assets + dispatches routes
├── routes/
│   ├── index.js             # / → usage page
│   ├── proxy.js             # /proxy/<url> → generic media proxy
│   ├── video.js             # /vid/<url> and /vid/d/<url> → Artplayer HTML
│   ├── image.js             # /img/<url> and /img/d/<url> → image viewer HTML
│   ├── html.js              # /html/<url> → HTML fetch + rewrite
│   ├── wechat.js            # /wechat/<url> → WeChat article HTML
│   └── tweet.js             # /<user>/status/<id>[?mode=] → tweet HTML
├── lib/
│   ├── utils.js             # shared pure functions (proxyUrl, formatDate, parseMedia, etc.)
│   ├── markdown.js          # markdown → HTML (markdown-it + highlight.js), used by /github/
│   └── to-markdown.js       # HTML → markdown (Workers AI toMarkdown), used by /html/ + /wechat/
├── wrangler.toml            # service config, env vars, observability, Text module rules
├── water.css                # base styles for tweet HTML (CI-fetched, Text-module inlined)
├── twitter.css              # tweet-specific overrides (Text-module inlined)
├── artplayer.js             # Artplayer source (CI-fetched + esbuild minified)
├── README.md                # end-user-facing docs (Chinese)
└── .github/workflows/deploy.yaml
```

## Routing

| Path                             | Service |
| -------------------------------- | ------- |
| `/<user>/status/<id>[?mode=m]`  | Tweet → standalone HTML; `?mode=self` / `quote` / `thread` / `all`（缺省即 `all`，全部推文） |
| `/vid/<raw-url>`                 | Video → player HTML (proxied, Range passthrough) |
| `/vid/d/<raw-url>`               | Video → player HTML (direct, no proxy) |
| `/img/<raw-url>`                 | Image → adaptive HTML (strips `Content-Disposition: attachment`) |
| `/img/d/<raw-url>`               | Image → adaptive HTML (direct) |
| `/html/<raw-url>`                | HTML fetch + rewrite (custom UA, proxy media, rewrite `<a>` hrefs); `Accept: text/markdown` → markdown |
| `/wechat/<raw-url>`              | WeChat article fetch (title links back to original); `Accept: text/markdown` → markdown |
| `/proxy/<raw-url>`               | Generic passthrough proxy; rewrites JS/CSS relative URLs |
| `/github/<user>/<repo>[/<path>]` | GitHub README or arbitrary file → rendered HTML; directory → file listing (media proxied via `/proxy/`) |
| `/`                              | Unified usage page (zh/en) |

> URL is appended raw — the browser handles necessary encoding automatically. Only encode (`encodeURIComponent`) when the URL contains special characters (`?`, `#`, space, non-ASCII).

Route priority in `worker.js`: root → favicon → `/vid/` → `/img/` → `/html/` → `/wechat/` → `/proxy/` → `/github/` → tweet (fallback) → 404.

### /html/ rewrite rules

The `/html/` route (`routes/html.js`) fetches the target page and rewrites it with HTMLRewriter before returning:

- **`<img>` / `<video>` / `<audio>` / `<source>` / `<embed>` / `<object>` / `<iframe>` / `<track>`** —
  rewrite `src`/`data-src`/`srcset`/`poster`/`data` to `/proxy/<encoded>` so media loads through the Worker (bypassing hotlink protection)
- **`<script>` / `<link>`** — only proxy absolute CDN URLs; skip relative paths (their internal relative imports break when loaded from the worker domain)
- **`<a>`** — rewrite `href` to `/html/<url>` so navigation stays within the proxy system (relative paths are resolved against the original page URL first)
- **`<style>` blocks and inline `style` attributes** — rewrite `url(...)` references to proxy paths

The `/proxy/` route (`routes/proxy.js`) additionally rewrites JS/CSS **content**: relative `import("./...")`, `from"./..."`, and `url(...")` references are converted to absolute proxy paths,
so Vite-style chunk loading works through the proxy.

### `Accept: text/markdown` (tweet / html / wechat)

These three routes return `text/markdown` when the request's `Accept` header mentions
`text/markdown`; otherwise they return HTML unchanged. **Every branch sets `Vary: Accept`** —
without it the edge would serve a cached HTML response to a markdown client.

Responses also carry `x-markdown-tokens` (CJK-aware estimate from `estimateTokens()` in `lib/utils.js`).

The tweet route renders markdown from fxtwitter data itself. `/html/` and `/wechat/` instead go
through Workers AI `toMarkdown` (`lib/to-markdown.js`), with three constraints:

- **Always pass the fetched HTML string, never let the converter fetch the URL.** `/html/` and
  `/wechat/` depend on a custom User-Agent (default iOS WeChat) plus Referer to retrieve bodies;
  only the Worker can do that. The converter receives the already-fetched HTML as a blob.
- **Relative URLs are resolved by injecting a `<base href>` tag.** After `buildRewriter()` every
  `<a href>` is `/html/<abs>` and every media attribute is `/proxy/<abs>`, so no page-relative
  links remain; pointing the base at this Worker's origin absolutises both internal path families.
  `conversionOptions.html.hostname` is deliberately *not* used — it works over REST but is silently
  ignored through the Workers AI binding (verified on x-dev: 78 links emitted relative). The
  converter still drops `srcset` and `data-src`-only images, which is why `buildRewriter()`'s
  srcset/`data-src`→`src` backfill must stay.
- **Results must be cached in R2** under `md/<route>/<target>`. HTML conversion is deterministic
  and model-free (0 Neurons), but a single page takes 130–330 ms and ~8% of requests show a
  48–100 s tail, so each URL is converted at most once for its lifetime. `?refresh=1` forces a
  re-conversion. Failures return `502`/`406` and are never written to R2. Input over ~4 MiB is
  rejected fast by `MAX_INPUT_CHARS` — the service otherwise hangs ~41 s before erroring.


## Inlined Assets (Text Module Rules)

All rendered HTML is fully self-contained — no external `<link>` or `<script>` tags.
Three assets are inlined into HTML, each through a different mechanism:

| Asset           | Source                                      | Mechanism                   | In worker.js |
| --------------- | ------------------------------------------- | --------------------------- | ------------ |
| `water.css`     | CDN (jsdelivr)                              | `Text` module rule → string | `import WATER_CSS from "./water.css"` |
| `twitter.css`   | Repo file                                   | `Text` module rule → string | `import TWITTER_CSS from "./twitter.css"` |
| `artplayer.mjs` | CI-generated from `artplayer.js` (jsdelivr) | ESM default-exported string | `import ARTPLAYER_JS from "./artplayer.mjs"` |

The CSS assets are minified by `esbuild`; the Artplayer JS avoids esbuild
(its minified source contains backticks/`${` that would break template literals) and instead is wrapped by CI as `export default "<JSON-escaped source>"`.

None of these files are committed; CI fetches and transforms them before deploy.

### CI Pipeline (`.github/workflows/deploy.yaml`)

1. `npx wrangler deploy` — Wrangler runs the `[build]` command (`sh build.sh`) first, which downloads and builds all remote assets (CSS, artplayer, markdown-it, highlight.js), then deploys.
2. Re-enables the Worker Cache runtime setting via API (Wrangler resets it on each deploy).

Trigger paths: push to `worker.js`, `routes/**`, `lib/**`, `twitter.css`, `wrangler.toml`, `deploy.yaml`; or `workflow_dispatch`.

## Vars

| Var            | Purpose |
| -------------- | ------- |
| `TIMEZONE`     | Tweet timestamp display timezone |
| `TRANSLATE_TO` | BCP-47 language for tweet translation; blank = original |
| `GITHUB_TOKEN` | Optional GitHub PAT for `/github/` route to raise the API rate limit (60/h → 5000/h); blank = unauthenticated (public repos only) |
| `UA`           | User-Agent override for `/html/` fetches; defaults to iOS WeChat UA |

Bindings: `env.TWEETS` → R2 bucket `x-page` / `x-page-dev` (keys `tweet/`, `wechat/`, `md/`);
`env.AI` → Workers AI, used only for the markdown conversion. `toMarkdown()` on HTML is
deterministic and model-free, so it consumes 0 Neurons and never touches the free plan's
10,000 Neurons/day pool (verified on this free account, 2026-10). Note the markdown conversion
feature carries a **Beta** badge in the Cloudflare docs nav — Workers AI itself is GA.


### Local Development

```bash
# Download & build all remote assets (CSS, JS), then start dev server
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

**Do NOT wait for the GitHub Actions `Deploy` workflow to pass** — it is frequently slow / queued for minutes and is not a reliable gate. Deploy via Wrangler directly for both stages.

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
- 2-space indent. `worker.js` is the router only; services live
  in `routes/`, shared helpers in `lib/`.
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

**踩坑症状**：wrangler 部署时打印 `Unexpected fields found in r2_buckets[0] field: "rules"`，CSS/其他 Text 模块没被打包，Worker 里 `import WATER_CSS from "./water.css"` 拿到的是空对象，HTML `<style>` 标签里直接渲染成 `[object Object]` 字符串 —— 页面布局完全乱掉。

**为什么裸形式有时能用**：TOML 规定紧跟 `[[array]]` 项后、未被更上一级 `[table]` 切分前，裸字段都属于那个数组项。当 `wrangler.toml` 只有一个 `rules = [...]` 而没有其他 `[[xxx]]` 块时，它属于顶层 worker-config 表，能正常工作；**一旦加上 `[[r2_buckets]]` 等块且顺序在 rules 之前/之后无 `[table]` 切分，rules 就被吞掉**。

**修复**：所有 wrangler config（prod + dev）一律用 `[[rules]]` 数组表头形式，并把 `[[rules]]` 放在其他 `[[array]]` 块之前。

**验证手段**：部署后 `curl` 任意一条路由，看 HTML head 的 `<style>` 标签里是真实 CSS 还是 `[object Object]`。

## Testing

No automated suite.
Validate manually: `npx wrangler dev` then curl/navigate each route prefix; use `curl -H "Range: bytes=0-..."` to exercise range passthrough on `/vid/` and `/proxy/`.

## Commit & PRs

- Imperative-mood messages: `add image proxy route`, `fix: strip content-disposition on proxy`.
- One concern per PR.
  If you touch routing, include a curl example for each affected prefix.
