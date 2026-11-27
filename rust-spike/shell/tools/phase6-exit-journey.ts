/** Real dev instance, signed registry mutations and real host operations. No response interception. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";
const expect = playwrightExpect.configure({ timeout: 60_000 });
assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const target = process.env.CARGO_TARGET_DIR!;
const out = process.env.EXIT_OUT ?? "/tmp/js422-evidence/journey";
const lanHost =
  process.env.EXIT_LAN_HOST ??
  Object.values(networkInterfaces())
    .flat()
    .find((address) => address?.family === "IPv4" && !address.internal)?.address;
assert(
  lanHost && isIP(lanHost) === 4 && !lanHost.startsWith("127.") && lanHost !== "0.0.0.0",
  "LAN IPv4 required"
);
mkdirSync(out, { recursive: true });
const hold = mkdtempSync(join(out, "fixture-"));
writeFileSync(join(out, "active-fixture"), hold);
const urls = getMossDatabaseUrls();
const fixture = spawn(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "phase6_exit_journey",
    "phase6_exit_journey",
    "--",
    "--exact",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      LIFECYCLE_SCREENS: "1",
      EXIT_JOURNEY: "1",
      CATALOG_LAN_HOST: lanHost,
      CATALOG_HOLD: hold,
      CATALOG_WEB: join(target, "web"),
      JS43_APP_URL: urls.app,
      JS43_WORKER_URL: urls.worker,
      JS43_BOOTSTRAP_URL: urls.bootstrap,
      JS43_MIGRATION_URL: urls.migration,
      JS170_AUTH_URL: urls.auth,
      JS170_SERVER: join(target, "debug/moss-server"),
      JS170_CERTIFICATE: join(target, "debug/moss-network")
    }
  }
);
let fixtureExit: number | null = null;
const exited = new Promise<number>((resolve) =>
  fixture.on("exit", (code) => {
    fixtureExit = code ?? 1;
    resolve(fixtureExit);
  })
);
async function waitFor(path: string, timeout = 900_000) {
  const end = Date.now() + timeout;
  while (!existsSync(path)) {
    assert.equal(fixtureExit, null, `fixture ended before ${path}`);
    assert(Date.now() < end, `deadline ${path}`);
    await delay(200);
  }
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await waitFor(join(hold, "ready.json"));
  const { origin } = JSON.parse(readFileSync(join(hold, "ready.json"), "utf8")) as {
    origin: string;
    instance: string;
    registry: string;
  };
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--force-prefers-reduced-motion"]
  });
  async function person(email: string) {
    const context = await browser!.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce"
    });
    const login = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin },
      data: { email, password: "temporary-bootstrap-password-179-not-a-real-secret" }
    });
    assert.equal(login.status(), 200, "real sign-in");
    return context;
  }
  assert.equal(new URL(origin).hostname, lanHost, "browser uses LAN address throughout");
  const admin = await person("bootstrap-owner@example.test");
  const member = await person("policy-member@example.test");

  let commandId = 0;
  async function command(action: string, width: string, snapshot?: string) {
    rmSync(join(hold, "reply"), { force: true });
    writeFileSync(
      join(hold, "command.next"),
      JSON.stringify({ action, width, snapshot, id: ++commandId })
    );
    renameSync(join(hold, "command.next"), join(hold, "command.json"));
    await waitFor(join(hold, "reply"), 30_000);
    assert.equal(JSON.parse(readFileSync(join(hold, "reply"), "utf8")), commandId);
  }
  async function saved(page: Page) {
    const id = new URL(page.url()).searchParams.get("operation");
    assert(id, "persisted operation URL");
    return getOperation(id);
  }
  async function getOperation(id: string) {
    const response = await admin.request.get(`${origin}/api/modules/operations/${id}`);
    assert.equal(response.status(), 200);
    return response.json();
  }
  async function waitOperation(id: string, stage: string) {
    await expect.poll(async () => (await getOperation(id)).stage).toBe(stage);
    return getOperation(id);
  }
  async function post(path: string, data: unknown) {
    const response = await admin.request.post(`${origin}${path}`, { headers: { origin }, data });
    assert(response.ok(), `real host ${path}: ${response.status()}`);
    return response.json();
  }
  async function rows(width: string) {
    await command("rows", width);
    return JSON.parse(readFileSync(join(hold, "rows.json"), "utf8"));
  }
  async function fits(page: Page) {
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "no page overflow"
    );
    for (const dialog of await page.getByRole("dialog").all()) {
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth), "no modal overflow");
    }
  }
  for (const [width, pixels] of [
    ["desktop", 1440],
    ["phone", 390]
  ] as const) {
    const module = `lifecycle-${width}`;
    const name = `Finance ${width}`;
    const detail = `${origin}/settings/modules?module=${module}&source=moss-fixture`;
    const page = await admin.newPage();
    await page.setViewportSize({ width: pixels, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    async function install() {
      await page.goto(`${origin}/settings/modules`);
      await page.getByRole("link", { name: "Browse", exact: true }).click();
      await page.getByLabel("Search", { exact: true }).fill(name);
      const row = page.locator(`article.catalog-row[data-module="${module}"]`);
      await expect(row).toBeVisible();
      await row.getByRole("link", { name, exact: true }).click();
      await page.getByRole("link", { name: `Install ${name}`, exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("button", { name: `Install ${name}`, exact: true }).click();
      await expect(
        page.getByRole("heading", { name: `${name} is ready`, exact: true })
      ).toBeVisible();
      assert.equal((await saved(page)).stage, "succeeded");
    }
    await install();
    const memberPage = await member.newPage();
    await memberPage.setViewportSize({ width: pixels, height: 844 });
    await memberPage.goto(`${origin}/settings/modules`);
    await expect(memberPage.locator(`article.catalog-row[data-module="${module}"]`)).toBeVisible();
    await fits(memberPage);
    await memberPage.screenshot({ path: join(out, `${width}-member-installed.png`) });
    const memberRefusal = await member.request.post(`${origin}/api/modules/remove`, {
      headers: { origin },
      data: { module, deleteData: false }
    });
    assert.equal(memberRefusal.status(), 403, "member cannot remove an install-wide package");
    await command("plant", width);
    const original = await rows(width);
    assert.equal(original.length, 2, "real ledger rows for two accounts");
    assert(original.every((r: { amount: number }) => r.amount === 42013));
    await command("grow", width);
    await post("/api/modules/policy", { automatic: true, quietTime: true });
    await post("/api/modules/refresh", {});
    await page.goto(detail);
    await page.getByRole("link", { name: "Review update", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: `Update ${name}`, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("1.0.0 → 1.1.0");
    await expect(dialog).toContainText("Urgent");
    await expect(dialog).toContainText("Data update");
    await expect(dialog).toContainText("Bill reminders arrive on time.");
    const review = await saved(page);
    assert.equal(review.stage, "reviewed");
    assert(review.review.permissions.length > 0, "added permission");
    assert.equal(review.review.newMigrations.length, 1, "only the added migration");
    for (const permission of review.review.permissions)
      await expect(dialog).toContainText(permission.headline);
    const catalog = await (await admin.request.get(`${origin}/api/modules/catalog`)).json();
    assert.notEqual(
      catalog.modules.find((m: { id: string }) => m.id === module).installedDigest,
      review.review.digest,
      "permission growth waits even with automatic quiet-time updates"
    );
    await page.reload();
    await expect(dialog).toBeVisible();
    assert.equal((await saved(page)).id, review.id);
    assert.equal((await saved(page)).stage, "reviewed");
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-update-review.png`) });
    await dialog.getByRole("button", { name: "Skip", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/settings/modules`);
    await page.reload();
    const skipped = await (await admin.request.get(`${origin}/api/modules/catalog`)).json();
    assert.equal(
      skipped.modules.find((m: { id: string }) => m.id === module).skippedDigest,
      review.review.digest
    );
    await page.goto(detail);
    await page.getByRole("button", { name: "Pin 1.0.0", exact: true }).click();
    await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, `${width}-pin.png`) });
    await page.getByRole("button", { name: "Unpin", exact: true }).click();
    await expect(page.getByRole("button", { name: "Pin 1.0.0", exact: true })).toBeVisible();
    console.log(
      `PASS ${width}: permission growth waits, exact added review and markers, Skip and pin survive reload`
    );

    await page.getByRole("link", { name: "Review update", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Updated", exact: true })).toBeVisible();
    const updated = await saved(page);
    assert.equal(updated.stage, "succeeded");
    assert(updated.stages.includes("setting_up_data"));
    assert.equal(updated.review.version, "1.1.0");
    assert.deepEqual(await rows(width), original, "approved update preserves both owners' rows");
    await page.reload();
    await expect(page.getByRole("heading", { name: "Updated", exact: true })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-updated.png`) });
    console.log(
      `PASS ${width}: LAN browse/install; member sees install and cannot remove; capability growth waits, Skip/pin reload, approved update succeeds with identical two-account ledger rows`
    );

    await page.goto(detail);
    await page.getByRole("link", { name: "Remove", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Remove ${name}`, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("All accounts. A snapshot stays for 30 days.");
    await dialog.getByLabel(`Type ${name}`, { exact: true }).fill("wrong name");
    await expect(
      dialog.getByRole("button", { name: "Remove and delete data", exact: true })
    ).toBeDisabled();
    // The real host also refuses a forged confirmation, with the same data untouched.
    const mismatch = await post("/api/modules/remove", {
      module,
      deleteData: true,
      typedName: "wrong name"
    });
    const refused = await waitOperation(mismatch.id, "failed");
    assert.match(refused.result.message, /Type the module name/);
    assert.deepEqual(await rows(width), original);
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-remove.png`) });
    await dialog.getByRole("button", { name: `Remove ${name}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Module removed", exact: true })).toBeVisible();
    assert.deepEqual(await rows(width), original, "remove keeps all rows");
    await install();
    assert.deepEqual(await rows(width), original, "reinstall keeps identical rows");
    console.log(
      `PASS ${width}: typed-name mismatch refuses in UI and host; remove and reinstall keep ledger rows`
    );

    await page.goto(`${detail}&screen=remove`);
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(`Type ${name}`, { exact: true }).fill(name);
    await dialog.getByRole("button", { name: "Remove and delete data", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Module removed", exact: true })).toBeVisible();
    assert.equal((await saved(page)).stage, "succeeded");
    await command("empty", width);
    assert.equal(
      JSON.parse(readFileSync(join(hold, "deleted.json"), "utf8")).rows,
      0,
      "deletion actually removed ledger rows"
    );
    await page.goto(detail);
    await page.getByRole("link", { name: "Restore", exact: true }).click();
    dialog = page.getByRole("dialog", { name: `Restore ${name}`, exact: true });
    await expect(dialog).toBeVisible();
    const snapshots = await (await admin.request.get(`${origin}/api/modules/snapshots`)).json();
    const snapshot = snapshots.find(
      (s: { module: string; reason: string }) => s.module === module && s.reason === "delete-data"
    );
    assert(snapshot);
    await dialog.getByLabel("Snapshot", { exact: true }).selectOption(snapshot.id);
    await expect(dialog).toContainText("All accounts");
    await expect(dialog).toContainText(`Current ${name} data`);
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-restore.png`) });
    await dialog.getByRole("button", { name: "Restore snapshot", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Snapshot restored", exact: true })
    ).toBeVisible();
    assert.deepEqual(
      await rows(width),
      original,
      "restore returns the identical IDs, owners, amounts and titles"
    );
    await page.screenshot({ path: join(out, `${width}-restored.png`) });
    await command("expire", width, snapshot.id);
    await page.goto(`${detail}&screen=restore&snapshot=${snapshot.id}`);
    dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(
      dialog
        .getByRole("option", { name: /Unavailable/ })
        .filter({ hasText: "Before data deletion" })
    ).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: "Restore snapshot", exact: true })
    ).toBeDisabled();
    await expect(dialog.getByText("Snapshot unavailable.", { exact: true })).toBeVisible();
    const expired = await post("/api/modules/restore", {
      module,
      snapshot: snapshot.id,
      typedName: name,
      acknowledgeDataLoss: true
    });
    assert.match((await waitOperation(expired.id, "failed")).result.message, /expired/);
    assert.deepEqual(await rows(width), original);
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-expired.png`) });
    assert.deepEqual(errors, [], "no browser exceptions");
    await memberPage.reload();
    await expect(memberPage.locator(`article.catalog-row[data-module="${module}"]`)).toBeVisible();
    await memberPage.close();
    await page.close();
    console.log(
      `PASS ${width}: delete/restore exact all-account ledger rows; real expired snapshot unavailable in selector and host`
    );
  }
  if (process.env.EXIT_INSPECT === "1") {
    writeFileSync(join(hold, "inspection-ready"), origin);
    console.log("Real LAN fixture ready for task browser (address kept outside public evidence)");
    await waitFor(join(hold, "inspection-complete"), 600_000);
  }
  await member.close();
  await admin.close();
  console.log(
    "PASS phase6_exit_journey: desktop and phone over LAN; two signed-in accounts; real signed packages and committed lifecycle operations",
    out
  );
} finally {
  await browser?.close();
  writeFileSync(join(hold, "release"), "done");
  assert.equal(await exited, 0, "real fixture completed");
}
