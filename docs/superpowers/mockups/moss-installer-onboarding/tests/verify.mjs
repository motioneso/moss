import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const files = [];
function walk(dir = "") {
  for (const entry of readdirSync(join(root, dir))) {
    const p = join(dir, entry);
    if (statSync(join(root, p)).isDirectory()) walk(p);
    else files.push(p);
  }
}
walk();
const app = read("app.js"),
  html = read("index.html"),
  css = read("style.css") + read("tokens.css");
assert.equal(
  spawnSync(process.execPath, ["--check", join(root, "app.js")]).status,
  0,
  "JavaScript syntax"
);
assert.doesNotMatch(
  app,
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon)\s*\(|\b(?:localStorage|sessionStorage|indexedDB)\b|navigator\.(?:geolocation|clipboard|serviceWorker)|show(?:Directory|OpenFile|SaveFile)Picker|window\.open\s*\(|document\.cookie|mossFeedback|feedback-dialog|\/api\//,
  "No external action, storage or annotation integration"
);
assert.match(html, /connect-src 'none'/);
assert.match(html, /form-action 'none'/);
assert.match(html, /<script defer src="app.js"><\/script>/);
assert.doesNotMatch(html, /<script[^>]+type="module"|feedback\.(?:css|mjs)|https?:\/\//);
assert.doesNotMatch(app + html, /type=["'](?:password|email|file)["']/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.doesNotMatch(css, /@import|url\(["']?https?:|url\(["']?\/fonts/);
for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const p = match[1];
  if (p.startsWith("#")) continue;
  assert.ok(existsSync(join(root, p)), `HTML asset ${p}`);
}
for (const match of css.matchAll(/url\(["']?([^"')]+)["']?\)/g))
  assert.ok(existsSync(join(root, match[1])), `CSS asset ${match[1]}`);
for (const p of files.filter((x) => x.endsWith(".svg"))) {
  const s = read(p);
  assert.doesNotMatch(
    s,
    /<script|<foreignObject|\son\w+\s*=|<animate|(?:href|src)=["'](?:https?:|\/\/)/i,
    `Safe SVG ${p}`
  );
}
for (const p of files.filter(
  (x) => /\.(?:html|js|css|json|md|txt)$/.test(x) && !x.startsWith("tests/")
)) {
  const s = read(p);
  assert.doesNotMatch(
    s,
    /\b(?:library_file|sediment):\/\/|codex:\/\/|chatgpt\.com\/|\.chatgpt-site\.|\.sites\.chatgpt|\/workspace\/|\/Users\/|\/home\/|\b(?:192\.168\.|10\.\d+\.\d+\.|172\.(?:1[6-9]|2\d|3[01])\.)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
    `Privacy screen ${p}`
  );
}
for (const p of [
  "assets/providers/claude.svg",
  "assets/providers/openai.svg",
  "assets/providers/opencode.svg",
  "assets/providers/ollama.svg",
  "assets/park-welcome.svg",
  "assets/park-trail.svg"
])
  assert.ok(files.includes(p));
assert.equal(files.filter((x) => x.endsWith(".woff2")).length, 6);
assert.equal(JSON.parse(read("provenance.json")).registry.entries, 41);
console.log(
  `PASS: JavaScript syntax; ${files.length} file inventory; local asset resolution; CSP; no network/storage/annotation/native API; no secret-input controls; SVG safety; privacy scan; local fonts.`
);
