import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const ROOT = "/attempt/module";
const ORIGIN = "https://workshop.invalid";
const HOST_SOURCE = `
import React from "react";
import { createRoot } from "react-dom/client";
globalThis.__JARVIS_MODULE_RUNTIME__ = { contractVersion: 2, react: React, reactDomClient: { createRoot } };
const contribution = (await import("/module.mjs")).default;
if (contribution?.contractVersion !== 2 || typeof contribution.Root !== "function") throw new Error("invalid web contract");
const style = document.createElement("style");
style.textContent = contribution.css ?? "";
document.head.append(style);
createRoot(document.querySelector("#root")).render(React.createElement(contribution.Root, { hostActions: {} }));
`;

export async function render() {
  await build({
    entryPoints: ["/opt/ui/tokens.css", "/opt/ui/styles.css"],
    outdir: `${ROOT}/css`,
    bundle: true,
    logLevel: "silent"
  });
  await build({
    stdin: { contents: HOST_SOURCE, resolveDir: "/opt/workshop", sourcefile: "host.ts" },
    outfile: `${ROOT}/host.js`,
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    logLevel: "silent",
    define: { "process.env.NODE_ENV": '"production"' },
    external: ["/module.mjs"]
  });
  const css =
    (await readFile(`${ROOT}/css/tokens.css`, "utf8")) +
    (await readFile(`${ROOT}/css/styles.css`, "utf8"));
  const html =
    '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/host.css"><div id="root"></div><script type="module" src="/host.js"></script>';
  const routes = new Map([
    [`${ORIGIN}/`, { contentType: "text/html", body: html }],
    [`${ORIGIN}/host.css`, { contentType: "text/css", body: css }],
    [
      `${ORIGIN}/host.js`,
      { contentType: "text/javascript", body: await readFile(`${ROOT}/host.js`) }
    ],
    [
      `${ORIGIN}/module.mjs`,
      { contentType: "text/javascript", body: await readFile(`${ROOT}/dist/web/index.js`) }
    ]
  ]);
  const browser = await chromium.launch({
    executablePath: "/opt/chromium/headless_shell",
    headless: true,
    timeout: 15000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 900, height: 700 }
    });
    const page = await context.newPage();
    let failed = false;
    page.on("pageerror", () => {
      failed = true;
    });
    await context.route("**/*", async (route) => {
      const response = routes.get(route.request().url());
      if (response) await route.fulfill({ status: 200, ...response });
      else {
        failed = true;
        await route.abort();
      }
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 15000 });
    await page.locator("#root > *").first().waitFor({ state: "visible", timeout: 15000 });
    const image = await page.screenshot({
      path: `${ROOT}/preview.png`,
      fullPage: false,
      timeout: 15000
    });
    assert.ok(image.length <= 1048576 && !failed);
    await context.close();
  } finally {
    await browser.close();
  }
}
