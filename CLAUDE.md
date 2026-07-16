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
│   └── tweet.js             # /<user>/status/<id> → tweet HTML
├── lib/
│   └── utils.js             # shared pure functions (proxyUrl, formatDate, parseMedia, etc.)
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
| `/<user>/status/<id>`            | Tweet → standalone HTML with inlined media |
| `/vid/<raw-url>`                 | Video → player HTML (proxied, Range passthrough) |
| `/vid/d/<raw-url>`               | Video → player HTML (direct, no proxy) |
| `/img/<raw-url>`                 | Image → adaptive HTML (strips `Content-Disposition: attachment`) |
| `/img/d/<raw-url>`               | Image → adaptive HTML (direct) |
| `/html/<raw-url>`                | HTML fetch + rewrite (custom UA, proxy media, rewrite `<a>` hrefs) |
| `/wechat/<raw-url>`              | WeChat article fetch (title links back to original) |
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

1. `curl` downloads `water.css` from jsdelivr.
2. `npx esbuild *.css --minify` rewrites both CSS assets in place.
3. `curl` downloads `artplayer.js` from jsdelivr, then a Node one-liner wraps it as `artplayer.mjs` containing `export default "<stringified source>"` —
   `JSON.stringify` automatically escapes backticks, `${`, backslashes, etc.
4. `cloudflare/wrangler-action@v4` deploys.
5. Re-enables the Worker Cache runtime setting via API (Wrangler resets it on each deploy).

Trigger paths: push to `worker.js`, `routes/**`, `lib/**`, `twitter.css`, `wrangler.toml`, `deploy.yaml`; or `workflow_dispatch`.

## Vars

| Var            | Purpose |
| -------------- | ------- |
| `TIMEZONE`     | Tweet timestamp display timezone |
| `TRANSLATE_TO` | BCP-47 language for tweet translation; blank = original |
| `GITHUB_TOKEN` | Optional GitHub PAT for `/github/` route to raise the API rate limit (60/h → 5000/h); blank = unauthenticated (public repos only) |
| `UA`           | User-Agent override for `/html/` fetches; defaults to iOS WeChat UA |

### Local Development

```bash
# Download CSS and minify both CSS assets
curl -fsSL https://cdn.jsdelivr.net/npm/water.css@2/out/water.min.css -o water.css
npx esbuild *.css --minify --legal-comments=none --drop:console --drop:debugger --outdir=. --allow-overwrite

# Download artplayer.js and wrap as ES module (so backticks/${} in source stay escaped)
curl -fsSL https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js -o artplayer.js
node -e '
const fs = require("fs");
const src = fs.readFileSync("artplayer.js", "utf8");
fs.writeFileSync("artplayer.mjs", "export default " + JSON.stringify(src) + ";\n");
'
```

### Deploy & Test

**Always deploy and verify directly via `npx wrangler deploy`** — do NOT wait for the GitHub Actions `Deploy` workflow to pass.
The CI workflow is frequently slow / queued for minutes and is not a reliable gate.

```bash
# Deploy directly (overrides CI for speed & reliability)
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

## Testing

No automated suite.
Validate manually: `npx wrangler dev` then curl/navigate each route prefix; use `curl -H "Range: bytes=0-..."` to exercise range passthrough on `/vid/` and `/proxy/`.

## Commit & PRs

- Imperative-mood messages: `add image proxy route`, `fix: strip content-disposition on proxy`.
- One concern per PR.
  If you touch routing, include a curl example for each affected prefix.
