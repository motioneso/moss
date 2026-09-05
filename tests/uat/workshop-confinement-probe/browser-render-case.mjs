import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { chromium } from "/opt/playwright-core/index.mjs";

const ROOT = "/attempt/module";
const WEB_ROOT = `${ROOT}/dist/web`;
const ORIGIN = "https://workshop.invalid";

const HOST_SOURCE = `
import React from "react";
import { createRoot } from "react-dom/client";

globalThis.__JARVIS_MODULE_RUNTIME__ = {
  contractVersion: 2,
  react: React,
  reactDomClient: { createRoot }
};

const module = await import("/module.mjs");
const contribution = module.default;
if (contribution?.contractVersion !== 2 || typeof contribution.Root !== "function") {
  throw new Error("invalid external module web contribution");
}
const style = document.createElement("style");
style.textContent = contribution.css ?? "";
document.head.append(style);
createRoot(document.querySelector("#root")).render(
  React.createElement(contribution.Root, { hostActions: {} })
);
`;

/** Render and interact with the generated web contribution in confined Chromium. */
export async function renderAndCheckWeb() {
  const hostSource = `${ROOT}/host.ts`;
  const hostBundle = `${WEB_ROOT}/host.js`;
  await mkdir(`${ROOT}/browser-tmp`, { recursive: true });
  process.env.TMPDIR = `${ROOT}/browser-tmp`;
  await writeFile(hostSource, HOST_SOURCE, "utf8");
  const result = spawnSync(
    "/opt/esbuild",
    [
      hostSource,
      "--bundle",
      "--platform=browser",
      "--format=esm",
      "--target=es2022",
      '--define:process.env.NODE_ENV="production"',
      "--alias:react=/opt/react/index.js",
      "--alias:react-dom/client=/opt/react-dom/client.js",
      "--alias:react-dom=/opt/react-dom/index.js",
      "--alias:scheduler=/opt/scheduler/index.js",
      "--external:/module.mjs",
      `--outfile=${hostBundle}`
    ],
    { encoding: "utf8", timeout: 15_000, maxBuffer: 65_536 }
  );
  assert.equal(result.status, 0, `host bundle failed: ${result.stderr.slice(0, 4000)}`);

  const html =
    '<!doctype html><meta charset="utf-8"><div id="root"></div>' +
    '<script type="module" src="/host.js"></script>';
  const unexpected = [];
  const pageErrors = [];
  const browser = await chromium.launch({
    executablePath: "/opt/chromium/headless_shell",
    headless: true,
    timeout: 15_000,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  let context;
  try {
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 900, height: 700 }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await page.route("**/*", async (route) => {
      const url = route.request().url();
      if (url === `${ORIGIN}/`)
        return route.fulfill({ status: 200, contentType: "text/html", body: html });
      if (url === `${ORIGIN}/host.js`) {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: await readFile(hostBundle, "utf8")
        });
      }
      if (url === `${ORIGIN}/module.mjs`) {
        return route.fulfill({
          status: 200,
          contentType: "text/javascript",
          body: await readFile(`${WEB_ROOT}/index.mjs`, "utf8")
        });
      }
      unexpected.push(url);
      await route.abort();
    });
    await page.goto(`${ORIGIN}/`, { waitUntil: "load", timeout: 15_000 });
    await assert.doesNotReject(() => page.getByRole("heading", { name: "Daily word" }).waitFor());
    await page.getByRole("button", { name: "Show word" }).click();
    await page.getByText("quasar", { exact: true }).waitFor();
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(unexpected, []);
    const screenshot = await page.locator("#root").screenshot({ path: `${ROOT}/web-proof.png` });
    assert.ok(screenshot.byteLength <= 1_048_576, "web proof screenshot exceeds 1 MiB");
    console.log(
      JSON.stringify({
        check: "browser-render-and-click",
        status: "pass",
        screenshotSha256: createHash("sha256").update(screenshot).digest("hex"),
        screenshotBytes: screenshot.byteLength,
        browserVersion: browser.version()
      })
    );
  } finally {
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
