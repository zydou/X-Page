# Repository Guidelines

This is a single Cloudflare Worker that provides four services behind one hostname. The entire application lives in `worker.js`.

## Project Structure

```
x-page/
├── worker.js                # single-file ES module; all routing + logic
├── wrangler.toml            # service config, env vars, observability, Text module rules
├── water.css                # base styles for tweet HTML (CI-fetched, Text-module inlined)
├── twitter.css              # tweet-specific overrides (Text-module inlined)
├── artplayer.js             # Artplayer source (CI-fetched + esbuild minified)
├── README.md                # end-user-facing docs (Chinese)
└── .github/workflows/deploy.yaml
```

## Routing

| Path | Service |
|---|---|
| `/<user>/status/<id>` | Tweet → standalone HTML with inlined media |
| `/vid/<raw-url>` | Video → player HTML (proxied, Range passthrough) |
| `/vid/d/<raw-url>` | Video → player HTML (direct, no proxy) |
| `/img/<raw-url>` | Image → adaptive HTML (strips `Content-Disposition: attachment`) |
| `/img/d/<raw-url>` | Image → adaptive HTML (direct) |
| `/proxy/<raw-url>` | Generic passthrough proxy (any http(s) resource) |
| `/` | Unified usage page (zh/en) |

> URL is appended raw — the browser handles necessary encoding automatically. Only encode (`encodeURIComponent`) when the URL contains special characters (`?`, `#`, space, non-ASCII).

Route dispatch in `worker.js`: root → `/vid/` → `/img/` → `/proxy/` → tweet pattern → 404.

## Inlined Assets (Text Module Rules)

All rendered HTML is fully self-contained — no external `<link>` or `<script>` tags. Three assets are inlined into HTML, each through a different mechanism:

| Asset | Source | Mechanism | In worker.js |
|---|---|---|---|
| `water.css` | CDN (jsdelivr) | `Text` module rule → string | `import WATER_CSS from "./water.css"` |
| `twitter.css` | Repo file | `Text` module rule → string | `import TWITTER_CSS from "./twitter.css"` |
| `artplayer.mjs` | CI-generated from `artplayer.js` (jsdelivr) | ESM default-exported string | `import ARTPLAYER_JS from "./artplayer.mjs"` |

The CSS assets are minified by `esbuild`; the Artplayer JS avoids esbuild (its minified source contains backticks/`${` that would break template literals) and instead is wrapped by CI as `export default "<JSON-escaped source>"`.

None of these files are committed; CI fetches and transforms them before deploy.

### CI Pipeline (`.github/workflows/deploy.yaml`)

1. `curl` downloads `water.css` from jsdelivr.
2. `npx esbuild *.css --minify` rewrites both CSS assets in place.
3. `curl` downloads `artplayer.js` from jsdelivr, then a Node one-liner wraps it as `artplayer.mjs` containing `export default "<stringified source>"` — `JSON.stringify` automatically escapes backticks, `${`, backslashes, etc.
4. `cloudflare/wrangler-action@v4` deploys.
5. Re-enables the Worker Cache runtime setting via API (Wrangler resets it on each deploy).

Trigger paths: push to `worker.js`, `twitter.css`, `wrangler.toml`, `deploy.yaml`; or `workflow_dispatch`.

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

# Run locally with hot reload
npx wrangler dev

# Deploy
npx wrangler deploy
```

## Style Conventions

- Vanilla ES module JS. No TypeScript, no bundler, no linter.
- 2-space indent. Single `worker.js` — all routing, upstream fetch, header mutation, and HTML templates live in that file.
- User-supplied URLs are appended raw at the edge.
  Only `encodeURIComponent` when the URL contains `?`, `#`, space, or non-ASCII.
  When unsure, always encoding is safe.
  One-off tool: [meyerweb dencoder](https://meyerweb.com/eric/tools/dencoder/).
- All consumer-supplied assets must be inlined into templates; never reference an external origin in rendered HTML.

## Testing

No automated suite. Validate manually: `npx wrangler dev` then curl/navigate each route prefix; use `curl -H "Range: bytes=0-..."` to exercise range passthrough on `/vid/` and `/proxy/`.

## Commit & PRs

- Imperative-mood messages: `add image proxy route`, `fix: strip content-disposition on proxy`.
- One concern per PR. If you touch routing, include a curl example for each affected prefix.
