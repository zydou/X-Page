# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

## Project Overview

A Cloudflare Worker that converts X/Twitter tweets (including threads and
Articles) into self-contained HTML pages. It proxies tweet content through
`api.fxtwitter.com`, renders the result as a standalone HTML document with
inlined CSS, and serves it. No build step, no dependencies — plain ES module
JavaScript.

## Stack & Conventions

- **Runtime:** Cloudflare Workers (service name `x`)
- **Language:** Vanilla JavaScript (ES modules), no TypeScript, no bundler
- **No npm/`package.json`** — the app has zero runtime dependencies
- **CSS handling:** `worker.js` imports `.css` files as JS strings via a
  Wrangler Text module rule (`wrangler.toml` → `rules`). These get inlined
  into `<style>` tags, making the output HTML fully self-contained (avoids
  mixed-content blocks)
- **No linter, formatter, or test suite** configured

## URL Routes

All routes live in the single `fetch` handler in `worker.js`:

- `/{username}/status/{tweet_id}` — canonical tweet URL format
- `/{tweet_id}` — bare tweet ID
- `/proxy/<encodeURIComponent(url)>` — **internal media proxy**: fetches
  the original resource server-side (bypassing regional blocks) and streams
  it to the browser. Supports `Range` requests for video seeking. All
  images/videos/avatars in the HTML point here; no external proxy Worker
  needed.
- `/` and `/favicon.ico` — returns a bilingual (CN/EN) usage page
  (`indexHtml`)

The tweet ID is extracted by `extractPid()`, which tries the `/status/`
pattern first, then falls back to a bare numeric ID. The `/proxy/` route is
checked before `extractPid`.

## Architecture (`worker.js`, ~470 lines)

The entire application is a single file. Key functions in execution order:

1. **`handleProxy(request)`** — internal media proxy. Reads the target URL
   from `/proxy/<encoded>`, fetches it server-side, and streams the response
   back. Passes through `Range` requests for video seeking. Sets
   `Access-Control-Allow-Origin: *` and `Cache-Control: public, max-age=86400`.
2. **`extractPid(raw)`** — parses tweet ID from path
3. **`publish(rawPath, cfg)`** — main flow: fetches
   `https://api.fxtwitter.com/2/thread/{id}`, walks the thread (sorted
   `created_timestamp` ascending), builds HTML per post:
   - `authorTag()` — header with avatar + author + timestamp
   - `makeUrlClickable()` — auto-links URLs in tweet text
   - `parseArticle()` — renders Twitter Articles (headers, blockquotes,
     lists, inline bold/italic via `inlineStyle()`, media, quote tweets, code
     blocks)
   - `buildMediaTag()` / `parseMedia()` — image gallery and h.264 MP4
     videos, with landscape detection for CSS spanning
   - Quote tweets are recursively rendered (article previews show title +
     blockquote)
4. **`wrapHtml(body, author)`** — wraps everything in a full HTML doc with
   inlined `WATER_CSS` + `TWITTER_CSS`, sets OG tags and viewport
5. **`formatDate(ts, tz)`** — formats via `Intl.DateTimeFormat`
6. **`proxyUrl(url)`** — rewrites a media URL to `/proxy/<encoded>` so the
   browser pulls it through this Worker

API calls use `User-Agent: TelegramBot (like TwitterBot)` and a 3000ms
`AbortSignal.timeout`.

## Configuration

**`wrangler.toml`** — Worker entry point and Text module rules for CSS
imports. Runtime env vars (`[vars]` section, read via `import.meta.env` in
the Worker):

| Variable | Default | Purpose |
| --- | --- | --- |
| `TIMEZONE` | `Asia/Shanghai` | IANA timezone for date rendering |
| `TRANSLATE_TO` | `zh-cn` | BCP-47 language; sent as `?lang=` to fxtwitter |

**`twitter.css`** — overlay styles on top of water.css: `.tweet-header` flex
layout, `.tweet-avatar` circle, `.media-gallery` grid (2-col,
landscape/only-child spans both), `.tweet-media` sizing (80vh,
`object-fit: contain`).

## Deploy

CI/CD lives in `.github/workflows/deploy.yaml`. Triggers on push to
`worker.js`, `twitter.css`, `wrangler.toml`, or `deploy.yaml` itself, plus
`workflow_dispatch`.

Deploy pipeline:

1. Download `water.css` from jsDelivr CDN (it is **not** committed to the
   repo)
2. Minify all CSS via `npx esbuild *.css --minify --outdir=. --allow-overwrite`
3. Deploy via `cloudflare/wrangler-action@v4` using secret
   `CLOUDFLARE_API_TOKEN`

To deploy locally (requires Wrangler auth):

```bash
wrangler deploy
```

Note: `water.css` must exist locally before deploy (run the curl step
manually or `npx wrangler deploy` which fetches via the Text module rule).

## External Dependencies

- **`api.fxtwitter.com`** — sole upstream API (`/2/thread/{id}`). Worker is
  essentially an HTML-rendering frontend for it. `Accept: application/json`.
- **water.css** — fetched at CI time from
  `cdn.jsdelivr.net/npm/water.css@2/out/water.css`, minified, and inlined.

## File Map

| File | Role |
| --- | --- |
| `worker.js` | All logic — fetch handler, routing, HTML, media proxy |
| `wrangler.toml` | Worker config, CSS import rules, env vars |
| `twitter.css` | Tweet display styles (overlay on water.css) |
| `.github/workflows/deploy.yaml` | CI/CD — fetch CSS, minify, deploy |
| `water.css` | _(CI-generated)_ base stylesheet, inlined into output |
