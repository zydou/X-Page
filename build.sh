#!/bin/bash
set -e

echo "=== x-page build: downloading & building remote assets ==="

# ── 1. Fetch & Minify CSS ──────────────────────────────────────
if [ -f water.css ]; then
  echo "-> water.css already exists, skipping download."
else
  echo "-> Fetching water.css..."
  curl -fsSL https://cdn.jsdelivr.net/npm/water.css@2/out/water.min.css -o water.css
fi
echo "-> Minifying CSS assets..."
npx esbuild *.css --minify --legal-comments=none --drop:console --drop:debugger --outdir=. --allow-overwrite

# ── 2. Wrap artplayer.js as ES module ──────────────────────────
if [ -f artplayer.mjs ]; then
  echo "-> artplayer.mjs already exists, skipping."
else
  echo "-> Fetching artplayer.js..."
  curl -fsSL https://cdn.jsdelivr.net/npm/artplayer/dist/artplayer.js -o artplayer.js
  echo "-> Wrapping artplayer.js as ES module..."
  node -e '
  const fs = require("fs");
  const src = fs.readFileSync("artplayer.js", "utf8");
  fs.writeFileSync("artplayer.mjs", "export default " + JSON.stringify(src) + ";\n");
  console.log("OK artplayer.mjs generated (" + src.length + " bytes)");
  '
fi

# ── 3. Build markdown-it.mjs ───────────────────────────────────
if [ -f markdown-it.mjs ]; then
  echo "-> markdown-it.mjs already exists, skipping."
else
  echo "-> Building markdown-it.mjs..."
  npm install markdown-it@14.1.0 --no-save
  npx esbuild node_modules/markdown-it/index.mjs \
    --bundle --format=esm --platform=node --minify \
    --outfile=markdown-it.mjs
  node -e '
  const fs = require("fs");
  let src = fs.readFileSync("markdown-it.mjs","utf8");
  src = src.replace(/export\{Rt as default\};?/, "export const MarkdownIt = Rt;");
  fs.writeFileSync("markdown-it.mjs", src);
  '
  rm -rf node_modules package.json package-lock.json
  echo "OK markdown-it.mjs generated (" $(wc -c < markdown-it.mjs) "bytes)"
fi

# ── 4. Build highlight.mjs ─────────────────────────────────────
if [ -f highlight.mjs ]; then
  echo "-> highlight.mjs already exists, skipping."
else
  echo "-> Building highlight.mjs..."
  mkdir -p build/languages
  for lang in javascript typescript python go rust c cpp java ruby php bash sql json yaml markdown; do
    curl -fsSL "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/languages/${lang}.min.js" -o "build/languages/${lang}.min.js"
  done
  curl -fsSL https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/highlight.min.js -o highlight.min.js
  curl -fsSL https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/github.min.css -o github.min.css
  curl -fsSL https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.10.0/build/styles/github-dark.min.css -o github-dark.min.css
  node -e '
  const fs = require("fs");
  const BUILTIN = ["javascript","typescript","python","go","rust","c","cpp","java","ruby","php","bash","sql","json","yaml","markdown"];
  const core = fs.readFileSync("highlight.min.js","utf8");
  const langs = BUILTIN.map(l => fs.readFileSync("build/languages/" + l + ".min.js","utf8"));
  const lightCss = fs.readFileSync("github.min.css","utf8");
  const darkCss = fs.readFileSync("github-dark.min.css","utf8");
  const themeCss = lightCss + "\n@media (prefers-color-scheme: dark) {\n" + darkCss + "\n}";
  const out = "/*! x-page highlight.js bundle - Worker-side rendering, browser zero JS */\n" + core + "\n" + langs.join("\n\n") + "\nfunction escapeHtml(s){return s.replace(/&/g,\"&amp;\").replace(/</g,\"&lt;\").replace(/>/g,\"&gt;\")}\nexport function highlightCode(value,language){try{return hljs.highlight(value,{language:language,ignoreIllegals:true}).value}catch(e){return escapeHtml(value)}}\nexport function highlightWith(value,language,source){try{new Function(\"hljs\",source)(hljs);return hljs.highlight(value,{language:language,ignoreIllegals:true}).value}catch(e){return escapeHtml(value)}}\nexport const BUILTIN_LANGS=new Set(" + JSON.stringify(BUILTIN) + ");\nexport const HLJS_THEME_CSS=" + JSON.stringify(themeCss) + ";\n";
  fs.writeFileSync("highlight.mjs", out);
  console.log("OK highlight.mjs generated (" + out.length + " bytes, " + BUILTIN.length + " builtin langs)");
  '
fi

# ── Clean up intermediate files ────────────────────────────────
rm -f artplayer.js highlight.min.js github.min.css github-dark.min.css
rm -rf build/

echo "=== build complete ==="
