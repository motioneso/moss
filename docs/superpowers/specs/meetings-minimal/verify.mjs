/* global document, innerWidth, getComputedStyle */
/** Static design checks. --layout adds local Chromium DOM assertions, never live-product proof. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const read = (file) => readFileSync(join(root, file), "utf8");
const screens = JSON.parse(read("screens.json"));
assert.match(
  read("03-recording.html"),
  /<svg(?=[^>]*fill="currentColor")(?=[^>]*stroke-width="0")(?=[^>]*lucide-square)[^>]*>/,
  "Stop has a filled square glyph"
);
assert.deepEqual(
  screens.map(({ file }) => file),
  ["01-not-linked", "02-ready", "03-recording", "04-settings"]
);
const referenceHashes = {
  "02-change-settings.html": "67e07e9d9f3c736f8312f93279a7f045a3aec491",
  "04-approved.html": "cdeb3297807d42b1ed9930f10bf1071cccdcbf8d",
  "05-declined.html": "bceb072e1a91cbd3693204b9a5e835dbe465effc",
  "moss-ui.css": "5e746efd44767869fcbae05716597c9821331569",
  "mockup.css": "8b806ff4f8d0e5bd777dbac0df1e0dc30e3786dd",
  "FONT-LICENSE.txt": "8597481ebc941863ab228e79ea4305507cd73cc6"
};
for (const [file, expected] of Object.entries(referenceHashes)) {
  const bytes = readFileSync(join(root, "approval-card", file));
  const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(actual, expected, `Unchanged #3089 source: ${file}`);
}

const files = [
  ...readdirSync(root).filter((file) => /\.(html|css)$/.test(file)),
  ...readdirSync(join(root, "approval-card"))
    .filter((file) => /\.(html|css)$/.test(file))
    .map((file) => `approval-card/${file}`)
];
for (const file of files) {
  const source = read(file);
  assert.doesNotMatch(source, /<script\b/i, `${file}: no runtime script`);
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"|url\(["']?([^)'"\s]+)["']?\)/g)) {
    const value = match[1] ?? match[2];
    if (value.startsWith("data:") || decodeURIComponent(value).startsWith("#")) continue;
    assert.doesNotMatch(value, /^\w+:/, `${file}: no remote dependency`);
    assert.ok(existsSync(resolve(root, dirname(file), value)), `${file}: ${value}`);
  }
  if (!file.endsWith(".html")) continue;
  const css = [...source.matchAll(/<link[^>]+href="([^"]+)"/g)]
    .map((match) => readFileSync(resolve(root, dirname(file), match[1]), "utf8"))
    .join("\n");
  for (const match of source.matchAll(/\bjds-[\w-]+/g)) {
    assert.ok(css.includes(`.${match[0]}`), `${file}: defined class ${match[0]}`);
  }
  for (const match of source.matchAll(/var\((--[\w-]+)/g)) {
    assert.ok(css.includes(`${match[1]}:`), `${file}: defined token ${match[1]}`);
  }
}

const notLinked = read("01-not-linked.html");
assert.match(notLinked, /<button\b[^>]*>Download app<\/button>/);
assert.doesNotMatch(notLinked, /Moss address|Copy address|href="[^"]+"[^>]*>Download app/i);
const recording = read("03-recording.html");
const pill = recording.slice(recording.indexOf('aria-label="Recording controls"'));
const meter = pill.match(/<svg\b[\s\S]*?<\/svg\s*>/)?.[0];
assert.ok(meter, "Native level meter exists");
assert.equal((meter.match(/<rect\b/g) ?? []).length, 3, "Exactly three meter bars");
assert.doesNotMatch(meter, /<(path|polyline)\b/, "No zigzag waveform");
assert.equal((pill.match(/<button\b/g) ?? []).length, 2, "Only Pause and Stop controls");
assert.match(pill, /background: var\(--meeting-pill-surface\)/);
assert.match(pill, /border: 1px solid var\(--meeting-pill-pause-ring\)/);
assert.match(pill, /aria-label="Pause recording"/);
assert.match(pill, /aria-label="Stop recording"/);
assert.match(read("tokens.css"), /--meeting-pill-surface: var\(--white\)/);
assert.match(read("04-settings.html"), /Summarize automatically after Stop/);
assert.match(read("04-settings.html"), /type="checkbox"[\s\S]*?checked=""/);
assert.match(read("04-settings.html"), /value="computer-audio" selected=""/);
for (const { file } of screens) {
  assert.doesNotMatch(read(`${file}.html`), /Approve recording|Deny recording|Finish setup/);
}
const build = read("build.tsx");
assert.match(build, /specs\/meetings-minimal/);
assert.doesNotMatch(build, /setup-wizard|M1 12H4/);
assert.equal((build.match(/<rect x=/g) ?? []).length, 3);
assert.match(build, /<Switch/);
const spec = readFileSync(join(root, "../2026-10-06-meetings-minimal-design.md"), "utf8");
assert.match(spec, /one initial linking approval also grants the recording/);
assert.match(spec, /without authoritative prior recording consent must explicitly relink/);
assert.match(spec, /Summarize automatically after Stop/);
assert.doesNotMatch(spec, /approved warm Moss surface|small red waveform|three approved elements/);
for (const match of spec.matchAll(/\]\(([^)]+)\)/g)) {
  if (/^https:/.test(match[1])) continue;
  assert.ok(existsSync(resolve(root, "..", match[1].split("#")[0])), `Spec link: ${match[1]}`);
}
console.log(
  "PASS: local links, shipped classes/tokens, source invariants and 6 #3089 blob hashes."
);

if (process.argv.includes("--layout")) {
  const { chromium } = createRequire(import.meta.url)("playwright");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"]
  });
  let cases = 0;
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    const remoteRequests = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => {
      if (/^https?:/.test(request.url())) remoteRequests.push(request.url());
    });
    for (const width of [1440, 390, 320]) {
      for (const mode of ["light", "dark", "teal"]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        for (const file of files.filter((value) => value.endsWith(".html"))) {
          await page.goto(pathToFileURL(join(root, file)).href);
          await page.evaluate((appearance) => {
            document.documentElement.dataset.colorMode = appearance === "dark" ? "dark" : "light";
            document.documentElement.dataset.theme = appearance === "teal" ? "teal" : "forest";
          }, mode);
          await page.evaluate(() => document.fonts.ready);
          assert.ok(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            `${file}: no horizontal overflow at ${width}px/${mode}`
          );
          if (file === "03-recording.html") {
            const geometry = await page
              .locator('[aria-label="Recording controls"]')
              .evaluate((el) => {
                const box = el.getBoundingClientRect();
                const pause = el.querySelector('[aria-label="Pause recording"]');
                return {
                  width: box.width,
                  height: box.height,
                  background: getComputedStyle(el).backgroundColor,
                  pauseRing: getComputedStyle(pause).borderColor,
                  text: el.innerText,
                  bars: el.querySelector(":scope > svg").children.length,
                  controls: [...el.querySelectorAll("button")].map((button) => ({
                    width: button.getBoundingClientRect().width,
                    height: button.getBoundingClientRect().height
                  }))
                };
              });
            assert.deepEqual(geometry, {
              width: 250,
              height: 80,
              background: "rgb(255, 255, 255)",
              pauseRing: "rgb(138, 138, 138)",
              text: "",
              bars: 3,
              controls: [
                { width: 54, height: 54 },
                { width: 54, height: 54 }
              ]
            });
          }
          cases++;
        }
      }
    }
    assert.deepEqual(pageErrors, [], "No browser errors");
    assert.deepEqual(remoteRequests, [], "No external requests");
    console.log(
      `PASS: ${cases} local DOM layout cases; white capsule, grey ring, 3 bars and geometry.`
    );
  } finally {
    await browser.close();
  }
}
