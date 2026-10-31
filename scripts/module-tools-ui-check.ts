/** Real host dialog, synthetic HTTP stand-ins. This is UI inspection, not installed live proof. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { chromium } from "playwright-core";

const root = process.cwd();
const dir = await mkdtemp(join(tmpdir(), "moss-module-tools-ui-"));
const artifacts = process.env.MOSS_VISUAL_ARTIFACT_DIR;
if (artifacts) await mkdir(artifacts, { recursive: true });
await build({
  entryPoints: ["tests/fixtures/module-tools-preview.tsx"],
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
      '@import "./apps/web/src/styles/tokens.css"; @import "./packages/ui/src/styles.css"; @import "./apps/web/src/styles.css";',
    loader: "css",
    resolveDir: root
  },
  outfile: join(dir, "style.css"),
  bundle: true,
  external: ["/fonts/*", "/images/*"]
});
let saves = 0;
let deletes = 0;
let cancellations = 0;
const decisions = new Set<string>();
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  try {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { confirmationId?: string };
      res.setHeader("content-type", "application/json");
      if (path.includes("assistant-actions")) {
        cancellations += 1;
        res.end("{}");
        return;
      }
      if (path.endsWith("demo.fail/invoke")) {
        res.statusCode = 503;
        res.end('{"error":"PRIVATE-SYNTHETIC-ERROR"}');
        return;
      }
      if (path.endsWith("demo.delete/invoke")) {
        if (!body.confirmationId) {
          const id = randomUUID();
          decisions.add(id);
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              invocation: { status: "blocked", reason: "confirmation_required" },
              confirmation: {
                id,
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
                moduleName: "Demo",
                actionLabel: "Delete the selected synthetic entry",
                risk: "destructive",
                inputSummary: {}
              }
            })
          );
          return;
        }
        assert(decisions.delete(body.confirmationId));
        deletes += 1;
      } else saves += 1;
      res.end('{"invocation":{"status":"succeeded","result":{"saved":true}}}');
      return;
    }
    if (path === "/host.js" || path === "/style.css") {
      res.setHeader("content-type", path.endsWith(".css") ? "text/css" : "text/javascript");
      res.end(await readFile(join(dir, path.slice(1))));
      return;
    }
    res.setHeader("content-type", "text/html");
    res.end(
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Moss host tools · synthetic UI fixture</title><div id="app"></div><script type="module" src="/host.js"></script></html>'
    );
  } catch {
    res.statusCode = 500;
    res.end();
  }
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
  headless: true,
  args: ["--no-sandbox"]
});
const evidence: unknown[] = [];
try {
  for (const width of [320, 390, 768, 1440])
    for (const mode of ["light", "dark"]) {
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        reducedMotion: "reduce"
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.locator("html").evaluate((el, value) => {
        el.setAttribute("data-color-mode", value);
        el.setAttribute("data-theme", "canyon");
      }, mode);
      const beforeSaves = saves;
      const beforeDeletes = deletes;
      await page.getByRole("button", { name: "Save entry", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
      assert.equal(saves, beforeSaves + 1);
      const opener = page.getByRole("button", { name: "Delete entry", exact: true });
      await opener.click();
      const dialog = page.getByRole("dialog", { name: "Confirm Demo action" });
      await dialog.waitFor();
      assert.equal(deletes, beforeDeletes);
      assert.equal(
        await page
          .getByRole("button", { name: "Confirm action", exact: true })
          .evaluate((el) => el === document.activeElement),
        false
      );
      for (let i = 0; i < 5; i++) {
        await page.keyboard.press("Tab");
        assert.equal(await dialog.evaluate((el) => el.contains(document.activeElement)), true);
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false
      );
      assert.equal(await dialog.evaluate((el) => el.scrollWidth > el.clientWidth), false);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `module-confirm-${width}-${mode}.png`),
          fullPage: true
        });
      await page.keyboard.press("Escape");
      await page.getByRole("status").filter({ hasText: "cancelled" }).waitFor();
      assert.equal(await opener.evaluate((el) => el === document.activeElement), true);
      assert.equal(deletes, beforeDeletes);
      await opener.click();
      await dialog.waitFor();
      await page.getByRole("button", { name: "Confirm action", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "succeeded" }).waitFor();
      assert.equal(deletes, beforeDeletes + 1);
      await opener.click();
      await dialog.waitFor();
      const beforeCancel = cancellations;
      await page.evaluate(() => window.dispatchEvent(new Event("fixture-owner-change")));
      await dialog.waitFor({ state: "detached" });
      await page.waitForFunction(
        () => document.querySelector('[role="status"]')?.textContent === "Ready"
      );
      assert.equal(deletes, beforeDeletes + 1);
      await page.getByRole("button", { name: "Uncertain save", exact: true }).click();
      const notice = page.getByRole("dialog", { name: "Check this change" });
      await notice.waitFor();
      assert.match(await notice.innerText(), /check whether the change saved/);
      assert.equal(
        (await page.locator("body").innerText()).includes("PRIVATE-SYNTHETIC-ERROR"),
        false
      );
      assert(cancellations > beforeCancel);
      assert.deepEqual(errors, []);
      evidence.push({
        width,
        mode,
        theme: "canyon",
        directSave: true,
        confirm: true,
        cancel: true,
        focus: true,
        actorChange: true,
        uncertainty: true,
        overflow: false
      });
      await page.close();
    }
  if (artifacts)
    await writeFile(
      join(resolve(artifacts), "module-tools-inspection.json"),
      JSON.stringify(evidence, null, 2)
    );
  process.stdout.write(
    `Host tools UI: ${evidence.length} scenarios passed (synthetic HTTP stand-ins).\n`
  );
} finally {
  await browser.close();
  await new Promise<void>((done) => server.close(() => done()));
  await rm(dir, { recursive: true, force: true });
}
