// Real Restore UI against the shared desktop Flow. No route interception or fake replies.
import { chromium } from "@playwright/test";
import { readFile, readdir, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import path from "node:path";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const config = JSON.parse(input);
input = "";
const browser = await chromium.launch({ args: ["--no-sandbox", "--force-prefers-reduced-motion"] });
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 900 }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120_000);
  await mkdir(config.proof, { recursive: true });
  const shot = (name) => page.screenshot({ path: path.join(config.proof, `${name}.png`) });
  const trace = async () => readFile(config.trace, "utf8").catch(() => "");
  const listing = async () =>
    (await readdir(path.join(config.data, "servers")).catch(() => [])).sort();
  const empty = async (label) => {
    const files = await listing();
    console.log(`${label} target listing: ${JSON.stringify(files)}`);
    assert.deepEqual(
      files.filter((name) => name !== "restore.lock"),
      [],
      "failed restore removes its partial staging root"
    );
  };
  await page.goto(config.origin);
  await page.getByRole("heading", { name: "Restore a backup", exact: true }).waitFor();
  await shot("pick-file");
  async function choose(file) {
    const choice = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Choose file", exact: true }).click();
    await (await choice).setFiles(file);
    await page.getByText(path.basename(file), { exact: true }).waitFor();
  }
  async function restore(file, words) {
    await choose(file);
    await page.getByRole("textbox", { name: "Recovery key words" }).fill(words.join(" "));
    await page.getByRole("button", { name: "Restore", exact: true }).click();
  }
  await choose(config.archive);
  await page.getByText("Moss on Restore source", { exact: true }).waitFor();
  // Capture the words-entry state before filling: recovery phrases never enter proof images.
  await shot("words");
  await restore(config.archive, [...config.words].reverse());
  await page.locator('[role="alert"][data-code="app_backup_wrong_key"]').waitFor();
  await empty("wrong words");
  assert.equal(await trace(), "", "wrong words write no staging data");
  await shot("wrong-words");
  await restore(config.damaged, config.words);
  await page.getByRole("alert").waitFor();
  assert.equal(
    (await trace()).includes("staging-created"),
    false,
    "damaged archive is checked before any staging write"
  );
  await page.locator('[role="alert"][data-code="app_backup_damaged"]').waitFor();
  await empty("damaged archive");
  await shot("damaged-archive");
  await restore(config.partial, config.words);
  await page.locator('[role="alert"][data-code="app_restore_failed"]').waitFor();
  assert.equal(
    (await trace()).includes("data-checked"),
    true,
    "cleanup case fails after real data restoration"
  );
  await empty("failed preparation");
  await restore(config.archive, config.words);
  await page.getByRole("heading", { name: "Your Moss is ready", exact: true }).waitFor();
  await shot("done");
  const roots = (await listing()).filter((name) => name.startsWith("restored-"));
  assert.equal(roots.length, 1, "only one complete instance was published");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByLabel("Email", { exact: true }).fill(config.email);
  await page.getByLabel("Password", { exact: true }).fill(config.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"));
  const session = await page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session");
    return { status: response.status, session: await response.json() };
  });
  assert.equal(session.status, 200, "restored server accepts the real sign-in");
  assert.equal(session.session.user.email, config.email, "the restored account signs in");
  await page.getByRole("heading", { name: "Today", exact: true }).waitFor();
  await shot("signed-in");
  console.log(
    "ok: selected file, source facts, wrong words, damaged archive, staging cleanup, restore and real sign-in"
  );
} finally {
  await browser.close();
}
