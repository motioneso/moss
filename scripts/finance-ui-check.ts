/** Synthetic actual-bundle inspection; no database, bank, credentials or production server. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { buildExternalModule } from "./build-external-module.js";

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), "moss-finance-ui-"));
const artifacts = process.env.MOSS_VISUAL_ARTIFACT_DIR;
if (artifacts) await mkdir(artifacts, { recursive: true });
await buildExternalModule(join(root, "external-modules/finance"));
await build({
  entryPoints: ["tests/fixtures/finance-parity-preview.tsx"],
  outfile: join(dir, "host.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  alias: {
    react: join(root, "apps/web/node_modules/react"),
    "react-dom": join(root, "apps/web/node_modules/react-dom")
  }
});
await build({
  stdin: {
    contents:
      '@import "./apps/web/src/styles/tokens.css"; @import "./packages/ui/src/styles.css"; @import "./apps/web/src/styles/components-forms.css"; @import "./apps/web/src/styles/components-keyline.css"; @import "./apps/web/src/styles.css";',
    loader: "css",
    resolveDir: root
  },
  outfile: join(dir, "style.css"),
  bundle: true,
  external: ["/fonts/*", "/images/*"]
});
const server = createServer(async (request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  try {
    const file =
      path === "/finance.js"
        ? join(root, "external-modules/finance/dist/web/index.js")
        : path === "/host.js" || path === "/style.css"
          ? join(dir, path.slice(1))
          : path.startsWith("/fonts/archivo/") && !path.includes("..")
            ? join(root, "apps/web/public", path)
            : null;
    if (file) {
      response.setHeader(
        "content-type",
        path.endsWith(".css")
          ? "text/css"
          : path.endsWith(".woff2")
            ? "font/woff2"
            : "text/javascript"
      );
      response.end(await readFile(file));
    } else {
      response.setHeader("content-type", "text/html");
      response.end(
        '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Moss Finance · synthetic UI fixture</title><main><header class="page-heading fnm-root"><h1>Finance</h1><p>Synthetic UI fixture · no bank connected</p></header><div id="app"></div></main><script type="module" src="/host.js"></script></html>'
      );
    }
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const base = `http://127.0.0.1:${address.port}/m/finance/transactions`;
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"]
});
const evidence: unknown[] = [];
try {
  for (const width of [320, 390, 768, 1440]) {
    for (const theme of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 1000 },
        reducedMotion: "reduce"
      });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(base);
      await page
        .locator("html")
        .evaluate((el, value) => el.setAttribute("data-theme", value), theme);
      await page.getByText("6 of 6 matching transactions loaded", { exact: false }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      assert.equal(overflow, false, `register overflow at ${width}/${theme}`);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `register-${width}-${theme}.png`),
          fullPage: true
        });
      const opener = page
        .getByRole("button", { name: "Split Weekend market", exact: true })
        .filter({ visible: true });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Split transaction", exact: true });
      await dialog.waitFor();
      assert.equal(
        await page.getByRole("button", { name: "Save split", exact: true }).isDisabled(),
        true
      );
      await page.getByLabel("Split category 2", { exact: true }).selectOption("dining");
      await page.getByLabel("Split amount 1", { exact: true }).fill("60.00");
      await page.getByLabel("Split amount 2", { exact: true }).fill("22.43");
      assert.equal(
        await page.getByRole("button", { name: "Save split", exact: true }).isEnabled(),
        true
      );
      assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth), false);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `split-${width}-${theme}.png`),
          fullPage: false
        });
      await page.keyboard.press("Escape");
      assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
      await page.getByLabel("Filter by posting status", { exact: true }).selectOption("pending");
      await page.getByText("1 of 1 matching transactions loaded", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Reports", exact: true }).click();
      await page.getByText("Choose a currency", { exact: true }).waitFor();
      await page.getByLabel("Report currency", { exact: true }).selectOption("EUR");
      await page.getByText("€6,543.21", { exact: true }).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `reports overflow at ${width}/${theme}`
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `reports-${width}-${theme}.png`),
          fullPage: true
        });
      await page.getByLabel("Report currency", { exact: true }).selectOption("USD");
      await page.getByText("$12,345.67", { exact: true }).waitFor();
      assert.equal(await page.getByText("€6,543.21", { exact: true }).count(), 0);
      evidence.push({ width, theme, reportCurrenciesSeparated: true });
      await page.getByRole("button", { name: "Accounts", exact: true }).click();
      const totals = page.getByLabel("Account totals by currency", { exact: true });
      await totals.getByText("$12,345.67", { exact: true }).waitFor();
      await totals.getByText("€6,543.21", { exact: true }).waitFor();
      await page.getByText("-$1,234.56", { exact: true }).waitFor();
      assert.equal(await page.getByText("$18,888.88", { exact: true }).count(), 0);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
        `accounts overflow at ${width}/${theme}`
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `accounts-${width}-${theme}.png`),
          fullPage: true
        });
      evidence.push({ width, theme, accountCurrenciesSeparated: true });
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        theme,
        overflow,
        keyboardRestore: true,
        filter: true,
        splitExactTotal: true
      });
      await page.close();
    }
  }
  for (const [fixture, text] of [
    ["empty", "Nothing yet"],
    ["error", "Request failed (503)"],
    ["loading", "Loading transactions"]
  ]) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto(`${base}?fixture=${fixture}`);
    await page.getByText(text!, { exact: false }).waitFor();
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `state-${fixture}.png`),
        fullPage: true
      });
    evidence.push({ fixture, visible: true });
    await page.close();
  }
  const overflowPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await overflowPage.goto(`${base}?fixture=accounts-overflow`);
  await overflowPage.getByRole("button", { name: "Accounts", exact: true }).click();
  await overflowPage.getByText("Unavailable", { exact: true }).waitFor();
  await overflowPage.getByText("$90,071,992,547,409.91", { exact: true }).waitFor();
  assert.equal(
    await overflowPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    "large individual balances must fit the account layout"
  );
  if (artifacts)
    await overflowPage.screenshot({
      path: join(resolve(artifacts), "accounts-overflow.png"),
      fullPage: true
    });
  evidence.push({ fixture: "accounts-overflow", totalUnavailable: true, exactCentsVisible: true });
  await overflowPage.close();
  if (artifacts)
    await writeFile(
      join(artifacts, "inspection.json"),
      JSON.stringify(
        { kind: "synthetic actual-bundle inspection; not live acceptance", evidence },
        null,
        2
      )
    );
  process.stdout.write(`Finance UI: ${evidence.length} scenarios passed (synthetic fixtures).\n`);
} finally {
  await browser.close();
  await new Promise<void>((done, reject) => server.close((e) => (e ? reject(e) : done())));
  await rm(dir, { recursive: true, force: true });
}
