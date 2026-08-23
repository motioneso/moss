#!/usr/bin/env node
// Renders a weekly digest content file into the Moss Weekly page.
//
// The design lives here, not in the writing agent's head: the agent produces content JSON and
// this script produces the markup. Keeping them apart is what stops the design drifting.
//
//   node render.mjs <content.json> --out <dir>     write index.html (and copy the stylesheet)
//   node render.mjs --stamp <agent.json> --archive-dir <dir> --friday <YYYY-MM-DD>
//                                                  add issue number and dates, print the result
//   node render.mjs --check <content.json>         validate without writing anything
//   node render.mjs --archive <dir>                rebuild archive/index.html from what is there
//   node render.mjs --self-test                    render the bundled example and check it

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  existsSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_URL = "https://github.com/motioneso/moss";

const esc = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const prLink = (number, label) => `<a href="${REPO_URL}/pull/${Number(number)}">${label}</a>`;

const refs = (prs = []) =>
  prs.map((n) => prLink(n, `PR&nbsp;#${Number(n)}`)).join('<span class="sep">·</span>');

const inlineRefs = (prs = []) =>
  prs.map((n) => prLink(n, `#${Number(n)}`)).join(' <span class="sep">·</span> ');

function requireFields(object, fields, where) {
  for (const field of fields) {
    if (object?.[field] === undefined || object?.[field] === null || object?.[field] === "") {
      throw new Error(`Missing "${field}" in ${where}`);
    }
  }
}

export function validate(content) {
  requireFields(content, ["issue", "weekOf", "slug", "summary", "intro", "headline"], "content");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(content.slug)) {
    throw new Error(`"slug" must look like 2026-08-21, got "${content.slug}"`);
  }
  requireFields(content.headline, ["title", "body"], "headline");
  for (const section of content.sections ?? []) {
    requireFields(section, ["title"], "a section");
    for (const item of section.items ?? [])
      requireFields(item, ["title", "body"], `an item in ${section.title}`);
  }
  for (const fix of content.fixes ?? []) requireFields(fix, ["text"], "a fix");
  return content;
}

function renderItems(items = []) {
  return items
    .map(
      (item) => `      <article class="item">
        <h4>${esc(item.title)}</h4>
        <p>${esc(item.body)}</p>${item.prs?.length ? `\n        <p class="refs">${refs(item.prs)}</p>` : ""}
      </article>`
    )
    .join("\n");
}

function renderSection(section) {
  return `  <section class="band">
    <h3>${esc(section.title)}</h3>
    <hr class="hr">
    <div class="items">
${renderItems(section.items)}
    </div>
  </section>`;
}

function renderFixes(fixes = []) {
  if (!fixes.length) return "";
  const list = fixes
    .map(
      (fix) => `      <li>${esc(fix.text)}${fix.prs?.length ? ` ${inlineRefs(fix.prs)}` : ""}</li>`
    )
    .join("\n");
  return `  <section class="band">
    <h3>Fixed</h3>
    <hr class="hr">
    <ul class="fixes">
${list}
    </ul>
  </section>`;
}

export function render(content, { cssHref = "weekly.css", archiveHref = "archive/" } = {}) {
  validate(content);
  const headlineBody = (
    Array.isArray(content.headline.body) ? content.headline.body : [content.headline.body]
  )
    .map((paragraph) => `      <p>${esc(paragraph)}</p>`)
    .join("\n");

  const sections = (content.sections ?? []).map(renderSection).join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moss weekly — Week of ${esc(content.weekOf)}</title>
<meta name="description" content="${esc(content.summary)}">
<link rel="stylesheet" href="${esc(cssHref)}">
</head>
<body>

<header class="masthead">
  <div class="shell">
    <span class="wordmark">Moss weekly</span>
    <span class="issue">Issue #${Number(content.issue)}</span>
  </div>
</header>

<main class="shell">

  <div class="lede">
    <h1>Week of ${esc(content.weekOf)}</h1>
    <p>${esc(content.intro)}</p>
  </div>

  <section class="hero">
    <div>
      <p class="eyebrow">This week's headline</p>
      <h2>${esc(content.headline.title)}</h2>
    </div>
    <div class="hero-body">
${headlineBody}${content.headline.prs?.length ? `\n      <p class="refs">${refs(content.headline.prs)}</p>` : ""}
    </div>
  </section>

${sections}

${renderFixes(content.fixes)}

  <div class="cta">
    <a href="${REPO_URL}">View Moss on GitHub</a>
  </div>

</main>

<footer class="colophon">
  <div class="shell">
    Moss · a weekly record of what shipped. <a href="${esc(archiveHref)}">Past issues</a>.
  </div>
</footer>

</body>
</html>
`;
}

export function renderArchive(entries) {
  const list = entries
    .map(
      (entry) =>
        `      <li><a href="${esc(entry.slug)}/">Issue #${Number(entry.issue)} — week of ${esc(entry.weekOf)}</a></li>`
    )
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moss weekly — past issues</title>
<link rel="stylesheet" href="../weekly.css">
</head>
<body>

<header class="masthead">
  <div class="shell">
    <span class="wordmark"><a href="../">Moss weekly</a></span>
    <span class="issue">Past issues</span>
  </div>
</header>

<main class="shell">
  <div class="lede">
    <h1>Past issues</h1>
  </div>
  <section class="band">
    <hr class="hr">
    <ul class="fixes">
${list}
    </ul>
  </section>
</main>

<footer class="colophon">
  <div class="shell">Moss · a weekly record of what shipped.</div>
</footer>

</body>
</html>
`;
}

function buildArchive(archiveDir) {
  const entries = readdirSync(archiveDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => {
      const meta = join(archiveDir, entry.name, "content.json");
      const content = existsSync(meta) ? JSON.parse(readFileSync(meta, "utf8")) : {};
      return { slug: entry.name, issue: content.issue ?? 0, weekOf: content.weekOf ?? entry.name };
    })
    .sort((a, b) => b.slug.localeCompare(a.slug));
  writeFileSync(join(archiveDir, "index.html"), renderArchive(entries));
  return entries.length;
}

// The writing agent supplies words only. Issue number and dates are bookkeeping, so they are
// worked out from the archive instead of trusted to a model.
function stamp(agentContent, archiveDir, fridayIso) {
  const previous = existsSync(archiveDir)
    ? readdirSync(archiveDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
        // Skip this week's own folder, so republishing a Friday keeps its issue number.
        .filter((entry) => entry.name !== fridayIso)
        .map((entry) => {
          const meta = join(archiveDir, entry.name, "content.json");
          return existsSync(meta) ? (JSON.parse(readFileSync(meta, "utf8")).issue ?? 0) : 0;
        })
    : [];
  const friday = new Date(`${fridayIso}T12:00:00Z`);
  if (Number.isNaN(friday.getTime())) throw new Error(`Bad date "${fridayIso}"`);
  const monday = new Date(friday.getTime() - 4 * 86400000);
  const weekOf = monday.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
  return { issue: Math.max(0, ...previous) + 1, slug: fridayIso, weekOf, ...agentContent };
}

function publish(contentPath, outDir) {
  const content = JSON.parse(readFileSync(contentPath, "utf8"));
  const archiveDir = join(outDir, "archive", content.slug);
  mkdirSync(archiveDir, { recursive: true });
  writeFileSync(join(outDir, "index.html"), render(content));
  writeFileSync(
    join(archiveDir, "index.html"),
    render(content, { cssHref: "../../weekly.css", archiveHref: "../" })
  );
  writeFileSync(join(archiveDir, "content.json"), `${JSON.stringify(content, null, 2)}\n`);
  copyFileSync(join(HERE, "weekly.css"), join(outDir, "weekly.css"));
  const count = buildArchive(join(outDir, "archive"));
  return { outDir, slug: content.slug, archived: count };
}

function selfTest() {
  const content = JSON.parse(readFileSync(join(HERE, "example-content.json"), "utf8"));
  const html = render(content);
  const checks = [
    ["has the issue number", html.includes(`Issue #${content.issue}`)],
    ["has the headline", html.includes(esc(content.headline.title))],
    ["links pull requests", html.includes(`${REPO_URL}/pull/`)],
    ["links the stylesheet", html.includes("weekly.css")],
    [
      "escapes angle brackets",
      render({ ...content, intro: "<script>x</script>" }).includes("&lt;script&gt;")
    ]
  ];
  let bad = 0;
  for (const [label, ok] of checks) {
    if (!ok) bad += 1;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  }
  try {
    render({ ...content, headline: { title: "x" } });
    console.log("FAIL rejects incomplete content");
    bad += 1;
  } catch {
    console.log("ok   rejects incomplete content");
  }
  if (bad) {
    console.error(`${bad} check(s) failed`);
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (args.includes("--self-test")) {
  selfTest();
} else if (args[0] === "--stamp") {
  const agentContent = JSON.parse(readFileSync(resolve(args[1]), "utf8"));
  const content = stamp(agentContent, resolve(flag("--archive-dir") ?? "."), flag("--friday"));
  validate(content);
  console.log(JSON.stringify(content, null, 2));
} else if (args[0] === "--check") {
  validate(JSON.parse(readFileSync(resolve(args[1]), "utf8")));
  console.log("Content looks complete");
} else if (args[0] === "--archive") {
  const dir = resolve(args[1] ?? ".");
  console.log(`Rebuilt contents page for ${buildArchive(dir)} issue(s)`);
} else if (args.length && !args[0].startsWith("--")) {
  const outIndex = args.indexOf("--out");
  const outDir = resolve(outIndex === -1 ? "." : args[outIndex + 1]);
  const result = publish(resolve(args[0]), outDir);
  console.log(
    `Wrote issue ${result.slug} to ${result.outDir} (${result.archived} issue(s) archived)`
  );
} else if (args.length) {
  console.error("Usage: render.mjs <content.json> --out <dir> | --archive <dir> | --self-test");
  process.exit(2);
}
