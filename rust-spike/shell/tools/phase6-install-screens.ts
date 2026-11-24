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
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect as playwrightExpect, type Page } from "@playwright/test";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";
const expect = playwrightExpect.configure({ timeout: 60_000 });
assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const target = process.env.CARGO_TARGET_DIR!;
const out = process.env.INSTALL_OUT ?? "/tmp/js419/proof";
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
    "phase6_install_screens",
    "phase6_install_screens",
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
      INSTALL_SCREENS: "1",
      CATALOG_HOLD: hold,
      CATALOG_WEB: join(target, "web"),
      JS43_APP_URL: urls.app,
      JS43_WORKER_URL: urls.worker,
      JS43_BOOTSTRAP_URL: urls.bootstrap,
      JS43_MIGRATION_URL: urls.migration,
      JS170_AUTH_URL: urls.auth,
      JS170_SERVER: join(target, "debug/moss-shell"),
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
  const { origin, instance, registry } = JSON.parse(
    readFileSync(join(hold, "ready.json"), "utf8")
  ) as { origin: string; instance: string; registry: string };
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
  const admin = await person("bootstrap-owner@example.test");
  const member = await person("policy-member@example.test");
  let commandId = 0;
  async function command(action: string, width: string) {
    rmSync(join(hold, "reply"), { force: true });
    writeFileSync(join(hold, "command.next"), JSON.stringify({ action, width, id: ++commandId }));
    renameSync(join(hold, "command.next"), join(hold, "command.json"));
    await waitFor(join(hold, "reply"), 30_000);
    assert.equal(JSON.parse(readFileSync(join(hold, "reply"), "utf8")), commandId);
  }
  async function operation(page: Page) {
    const id = new URL(page.url()).searchParams.get("operation");
    assert(id, "persisted journal URL");
    const response = await admin.request.get(`${origin}/api/modules/operations/${id}`);
    assert.equal(response.status(), 200);
    return response.json();
  }
  async function review(page: Page, width: string, kind: string) {
    await page.goto(`${origin}/settings/modules?view=browse`);
    await page.getByLabel("Search", { exact: true }).fill(`install-${width}-${kind}`);
    const row = page.locator("article.catalog-row");
    await expect(row).toHaveCount(1);
    await row.getByRole("link", { name: "View", exact: true }).click();
    await page.getByRole("link", { name: `Install ${width} ${kind}`, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `Install ${width} ${kind}`, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Moss registry");
    await expect(dialog).toContainText("1.0.0");
    const saved = await operation(page);
    assert.equal(saved.stage, "reviewed");
    assert.equal(saved.review.source, "moss-fixture");
    for (const permission of saved.review.permissions) {
      await expect(dialog).toContainText(permission.headline);
      for (const detail of permission.details) await expect(dialog).toContainText(detail);
    }
    return saved;
  }
  async function approve(page: Page, width: string, kind: string) {
    await page
      .getByRole("dialog")
      .getByRole("button", { name: `Install ${width} ${kind}`, exact: true })
      .click();
  }
  async function success(page: Page, width: string, kind: string) {
    await expect(
      page.getByRole("heading", { name: `${width} ${kind} is ready`, exact: true })
    ).toBeVisible();
    const saved = await operation(page);
    assert.equal(saved.stage, "succeeded");
    assert.equal(saved.result.ok, true);
    assert.deepEqual(
      saved.stages,
      [
        "reviewed",
        "queued",
        "checking",
        "downloading",
        "verifying",
        "setting_up_data",
        "activating",
        "succeeded"
      ],
      "real boundary history persisted"
    );
  }
  async function fits(page: Page) {
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "no horizontal overflow"
    );
  }
  for (const [width, pixels] of [
    ["desktop", 1440],
    ["phone", 390]
  ] as const) {
    const page = await admin.newPage();
    await page.setViewportSize({ width: pixels, height: 1000 });
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    const first = await review(page, width, "success");
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-review.png`) });
    // Native modal contains keyboard focus; Escape returns to the module detail.
    await page.keyboard.press("Tab");
    assert(await page.getByRole("dialog").evaluate((el) => el.contains(document.activeElement)));
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("link", { name: `Install ${width} success`, exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    writeFileSync(join(instance, "hold-installer"), "hold real supervisor credentials call");
    try {
      await approve(page, width, "success");
      await waitFor(join(instance, "installer-waiting"), 30_000);
      await expect(page.getByText("Queued…", { exact: true })).toBeVisible();
      const before = await operation(page);
      assert.equal(before.stage, "queued");
      await page.reload();
      await expect(page.getByText("Queued…", { exact: true })).toBeVisible();
      assert.equal((await operation(page)).id, before.id, "reload reads same host operation");
      await page.screenshot({ path: join(out, `${width}-reload.png`) });
    } finally {
      rmSync(join(instance, "hold-installer"), { force: true });
      rmSync(join(instance, "installer-waiting"), { force: true });
    }
    await success(page, width, "success");
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-result.png`) });
    assert.equal(
      (await member.request.get(`${origin}/api/modules/operations/${first.id}`)).status(),
      403,
      "member cannot read administrator journal"
    );
    console.log(
      `PASS ${width}: browse/review exact permissions, native modal focus/Escape, install, reload same persisted queued stage, result`
    );

    const old = await review(page, width, "changed");
    await command("change", width);
    await approve(page, width, "changed");
    await expect(
      page.getByRole("heading", { name: "This package changed. Review it again.", exact: true })
    ).toBeVisible();
    assert.equal((await operation(page)).stage, "failed");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("1.1.0");
    const fresh = await operation(page);
    assert.notEqual(fresh.id, old.id);
    assert.notEqual(fresh.review.digest, old.review.digest);
    assert.equal(fresh.stage, "reviewed", "fresh consent required");
    await page.screenshot({ path: join(out, `${width}-changed-review.png`) });
    await approve(page, width, "changed");
    await success(page, width, "changed");
    console.log(
      `PASS ${width}: changed signed offer refused; fresh digest reviewed and explicitly approved`
    );

    const download = await review(page, width, "download");
    const file = join(registry, `packages/${download.review.digest}.mosspkg`);
    const bytes = readFileSync(file);
    rmSync(file);
    try {
      await approve(page, width, "download");
      await expect(
        page.getByText("The package could not be downloaded.", { exact: true })
      ).toBeVisible();
      assert.equal((await operation(page)).result.message, "The package could not be downloaded.");
      await page.screenshot({ path: join(out, `${width}-download-failure.png`) });
    } finally {
      writeFileSync(file, bytes);
    }
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    assert.notEqual((await operation(page)).id, download.id);
    await approve(page, width, "download");
    await success(page, width, "download");
    console.log(`PASS ${width}: real missing download shows fixed reason, retry succeeds`);

    await review(page, width, "sql");
    await command("sql-conflict", width);
    await approve(page, width, "sql");
    await expect(
      page.getByText("The module data could not be set up.", { exact: true })
    ).toBeVisible();
    const failed = await operation(page);
    assert.equal(failed.result.message, "The module data could not be set up.");
    assert(failed.stages.includes("setting_up_data"), "host reached SQL step");
    assert(!failed.stages.includes("activating"), "SQL failure never claimed activation");
    for (const privateText of [
      "private_marker",
      `app.install_${width}_sql_entries`,
      "CREATE TABLE",
      "postgres://",
      registry,
      instance
    ])
      assert(
        !JSON.stringify(failed.result).includes(privateText),
        `no private error detail: ${privateText}`
      );
    await page.screenshot({ path: join(out, `${width}-sql-failure.png`) });
    await command("sql-repair", width);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await approve(page, width, "sql");
    await success(page, width, "sql");
    console.log(
      `PASS ${width}: real DDL conflict shows safe SQL reason without SQL/table/path/private content; retry succeeds`
    );
    assert.deepEqual(consoleErrors, [], "no browser errors");
    await page.close();

    const request = await member.newPage();
    await request.setViewportSize({ width: pixels, height: 1000 });
    await request.goto(
      `${origin}/settings/modules?module=community.garden&source=community-fixture`
    );
    await request.getByRole("link", { name: "Request to install", exact: true }).click();
    await expect(
      request.getByRole("heading", { name: "Request to install", exact: true })
    ).toBeVisible();
    assert.equal(new URL(request.url()).searchParams.get("screen"), "request");
    await request.goto(
      `${origin}/settings/modules?module=community.garden&source=community-fixture&screen=install`
    );
    await expect(
      request.getByRole("heading", { name: "Request to install", exact: true })
    ).toBeVisible();
    await request.goto(
      `${origin}/settings/modules?module=install-${width}-success&source=moss-fixture&screen=install&operation=${first.id}`
    );
    await expect(
      request.getByRole("heading", { name: "Request to install", exact: true })
    ).toBeVisible();
    await fits(request);
    await request.screenshot({ path: join(out, `${width}-member-request.png`) });
    await request.close();
    console.log(`PASS ${width}: member install entry and direct install URL route to S11`);
  }
  await admin.close();
  await member.close();
  console.log(
    "PASS phase6_install_screens: desktop and phone real operations; screenshots saved",
    out
  );
} finally {
  await browser?.close();
  writeFileSync(join(hold, "release"), "done");
  const code = await exited;
  assert.equal(code, 0, "real fixture completed");
}
