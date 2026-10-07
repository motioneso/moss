/** Static artifact checks only; these do not validate live approval behaviour. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(resolve(root, name), "utf8");
const screens = JSON.parse(read("screens.json"));
const memory = "I prefer morning meetings, and I keep Friday afternoons free for focused work.";
const notice = "Moss read something from outside your account before asking this.";
const target = (html) => html.match(/<p class="approval-target">([\s\S]*?)<\/p>/)?.[1];
const body = (html) =>
  html.split('<div class="chatd__body">')[1].split('<div class="chatd__composer">')[0];

test("all eight states use offline resources and inert controls", () => {
  assert.equal(screens.length, 8);
  for (const { file } of [...screens, { file: "index" }]) {
    const html = read(file + ".html");
    assert.doesNotMatch(html, /<script\b|\son\w+=|<form\b/);
    for (const [, url] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.doesNotMatch(url, /^(?:https?:|\/\/|javascript:)/);
      assert.ok(existsSync(resolve(root, url)), `${file}: missing ${url}`);
    }
  }
  assert.doesNotMatch(
    read("moss-ui.css").replace(/\/\*[\s\S]*?\*\//g, ""),
    /@import|url\(["']?https?:/
  );
  assert.match(read("moss-ui.css"), /data:font\/woff2;base64,/);
});

test("the default uses shipped primary Approve and secondary Reject", () => {
  for (const file of ["01-delete-memory", "02-change-settings", "03-outside-content"]) {
    const html = read(file + ".html");
    assert.match(html, /class="jds-btn jds-btn--primary">Approve<\/button/);
    assert.match(html, /class="jds-btn jds-btn--secondary">Reject<\/button/);
    assert.doesNotMatch(html, /jds-btn--danger|allow for this chat/i);
  }
});

test("red is an isolated memory-delete comparison with identical record text", () => {
  const html = read("08-delete-memory-comparison.html");
  assert.match(html, /class="jds-btn jds-btn--danger">Approve<\/button/);
  assert.equal(target(html), memory);
  assert.equal(
    body(html).replace("jds-btn--danger", "jds-btn--primary"),
    body(read("01-delete-memory.html"))
  );
});

test("server title, full target and field text survive formatting exactly", () => {
  assert.equal(target(read("01-delete-memory.html")), memory);
  assert.equal(target(read("02-change-settings.html")), "Weather");
  assert.equal(target(read("03-outside-content.html")), "Canyon after rain");
  const html = read("02-change-settings.html");
  assert.match(html, /<h2 class="approval-title">Change settings<\/h2>/);
  const pairs = [
    ...html.matchAll(/<dt>([^<]*)<\/dt>\s*<!-- prettier-ignore -->\s*<dd>([^<]*)<\/dd>/g)
  ].map((match) => match.slice(1));
  assert.deepEqual(pairs, [
    ["Temperature", "Celsius"],
    ["Wind speed", "Kilometres per hour"],
    ["Rainfall", "Millimetres"]
  ]);
});

test("only pending outside-content state contains the exact notice", () => {
  for (const { file } of screens) {
    const count = read(file + ".html").split(notice).length - 1;
    assert.equal(count, file === "03-outside-content" ? 1 : 0);
  }
});

test("resolved states leave exactly one quiet decision line", () => {
  for (const { file, title } of screens.slice(3, 7)) {
    const html = body(read(file + ".html"));
    const statuses = [
      ...html.matchAll(/<p class="jds-hint approval-outcome" role="status">([\s\S]*?)<\/p>/g)
    ];
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0][1].trim(), `${title} · Delete memory`);
    assert.doesNotMatch(
      html,
      /jds-card|approval-title|approval-target|approval-fields|approval-actions|approval-notice|<button/
    );
    assert.doesNotMatch(html, /executed|method|\/api\/|request body|tool name/i);
  }
});

test("all review states include desktop and phone frames", () => {
  const html = read("index.html");
  assert.equal([...html.matchAll(/<iframe\b/g)].length, 16);
  for (const { file } of screens) {
    assert.equal(html.split(`src="${file}.html"`).length - 1, 2);
  }
  assert.match(html, /Please review this style before the product build/);
  assert.match(read("moss-ui.css"), /width:\s*404px/);
  assert.match(read("mockup.css"), /width:\s*390px/);
});

test("every jds class is defined by the bundled design system", () => {
  const css = read("moss-ui.css");
  const used = new Set(
    screens.flatMap(({ file }) =>
      [...read(file + ".html").matchAll(/\bjds-[\w-]+/g)].map(([name]) => name)
    )
  );
  for (const name of used) assert.ok(css.includes(`.${name}`), name);
});
