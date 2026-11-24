/** Real Rust dev instance + signed fixture records. No request interception or response rewriting. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const target = process.env.CARGO_TARGET_DIR!;
const out = process.env.CATALOG_OUT ?? "/tmp/js418/proof";
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
    "phase6_catalog_screens",
    "--",
    "--ignored",
    "--nocapture",
    "--test-threads=1"
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
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
  const until = Date.now() + timeout;
  while (!existsSync(path)) {
    assert.equal(fixtureExit, null, `fixture ended before ${path}`);
    assert(Date.now() < until, `deadline ${path}`);
    await delay(250);
  }
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await waitFor(join(hold, "ready.json"));
  const { origin, instance } = JSON.parse(readFileSync(join(hold, "ready.json"), "utf8")) as {
    origin: string;
    instance: string;
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
    const response = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin },
      data: { email, password: "temporary-bootstrap-password-179-not-a-real-secret" }
    });
    assert.equal(response.status(), 200, "real sign-in");
    return context;
  }
  const admin = await person("bootstrap-owner@example.test");
  const member = await person("policy-member@example.test");
  // Capture the installed package's actual screens and publish their bytes as signed media.
  const capture = await admin.newPage();
  await capture.goto(`${origin}/module-frame?module=catalog-notes&path=%2Fcatalog-notes`);
  await capture.locator("iframe").first().waitFor();
  const guest = capture.frameLocator("iframe");
  await expect(guest.getByRole("heading", { name: "Notes", exact: true })).toBeVisible({
    timeout: 60_000
  });
  await capture.screenshot({ path: join(hold, "overview.png") });
  await capture.goto(`${origin}/module-frame?module=catalog-notes&path=%2Fcatalog-notes-settings`);
  await expect(
    capture.frameLocator("iframe").getByRole("heading", { name: "Notes settings" })
  ).toBeVisible();
  await capture.screenshot({ path: join(hold, "activity.png") });
  await capture.close();
  writeFileSync(join(hold, "media-ready"), "publish");
  await waitFor(join(hold, "published"), 30_000);
  // Refresh through the real admin endpoint so saved metadata has the new signed records.
  const refreshed = await admin.request.get(`${origin}/api/modules/catalog-view`);
  assert.equal(refreshed.status(), 200);
  let adminView = await refreshed.json();
  // A shell-open refresh already in flight may finish with the previous index.
  // Wait for a subsequent real refresh to read the newly published signed index.
  for (
    let attempt = 0;
    attempt < 5 && !adminView.modules.some((m: { screenshots: unknown[] }) => m.screenshots.length);
    attempt++
  ) {
    adminView = await (await admin.request.get(`${origin}/api/modules/catalog-view`)).json();
  }
  assert(
    adminView.modules.some((m: { screenshots: unknown[] }) => m.screenshots.length),
    JSON.stringify(adminView)
  );
  assert(Array.isArray(adminView.management), "admin configuration is separate");
  const mediaUrl = adminView.modules.find((m: { id: string }) => m.id === "catalog-notes")
    .screenshots[0].url;
  const file = mediaUrl.split("/").at(-1)!;
  const mediaFile = join(instance, "registry", "media", file);
  const original = readFileSync(mediaFile);
  const unlistedBytes = Buffer.concat([original, Buffer.from("unlisted")]);
  const unknown = createHash("sha256").update(unlistedBytes).digest("hex") + ".png";
  writeFileSync(join(instance, "registry", "media", unknown), unlistedBytes);
  const unsignedStatus = (
    await member.request.get(`${origin}/api/modules/catalog-media/moss-fixture/${unknown}`)
  ).status();
  writeFileSync(mediaFile, "tampered image");
  let tamperedStatus: number;
  try {
    tamperedStatus = (await member.request.get(origin + mediaUrl)).status();
  } finally {
    writeFileSync(mediaFile, original);
  }
  const memberReply = await member.request.get(`${origin}/api/modules/catalog-view`);
  assert.equal(memberReply.status(), 200);
  const memberView = await memberReply.json();
  const boundaries = {
    unsignedStatus,
    tamperedStatus,
    memberManagement: "management" in memberView
  };
  console.log("Catalog security boundaries", boundaries);
  assert.deepEqual(
    boundaries,
    { unsignedStatus: 404, tamperedStatus: 404, memberManagement: false },
    "MEDIA/MEMBER BOUNDARY"
  );
  console.log(
    "PASS media boundary: unsigned reference and altered bytes refused; member management omitted"
  );

  const encoded = JSON.stringify(memberView);
  for (const field of [
    "onForEveryone",
    "rootKey",
    "firstPartyKey",
    "publisherKey",
    "publisherPublicKey",
    "configuration",
    "ownerAccountId",
    "postgres://",
    "credentials.json",
    "folder"
  ])
    assert(!encoded.includes(field), `MEMBER BOUNDARY: ${field}`);
  for (const path of [
    "/api/modules/catalog",
    "/api/modules/registries",
    "/api/modules/policy",
    "/api/modules/list/export"
  ]) {
    assert.equal((await member.request.get(origin + path)).status(), 403, `member refused ${path}`);
  }
  assert.equal(
    (
      await member.request.post(`${origin}/api/modules/catalog-notes/server-switch`, {
        headers: { origin },
        data: { enabled: false }
      })
    ).status(),
    403
  );
  console.log(
    "PASS member boundary: display records only; admin catalog, registry configuration, policy, export and server switch refused"
  );

  async function browse(page: Page) {
    await page.getByRole("link", { name: "Browse", exact: true }).click();
    await expect(page.getByLabel("Search", { exact: true })).toBeVisible();
  }
  async function filters(page: Page) {
    const rows = page.locator("article.catalog-row");
    await page.getByLabel("Search", { exact: true }).fill("garden");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Garden planner");
    await page.getByLabel("Search", { exact: true }).fill("nothing-matches-js418");
    await expect(page.getByText("No modules match.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(rows).toHaveCount(2);
    await page.getByLabel("Source", { exact: true }).selectOption("community-fixture");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Community registry");
    await page.getByLabel("Source", { exact: true }).selectOption("");
    await page.getByLabel("Category", { exact: true }).selectOption("Home");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Garden planner");
    await page.getByLabel("Category", { exact: true }).selectOption("");
    await page.getByLabel("Publisher", { exact: true }).selectOption("first");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Notes");
    await page.getByLabel("Publisher", { exact: true }).selectOption("");
    await expect(rows).toHaveCount(2);
  }
  async function check(context: BrowserContext, role: string, width: number) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await page.goto(`${origin}/not-yet-built-js418`);
    await expect(page.getByText("Not built in the Rust app yet", { exact: true })).toBeVisible({
      timeout: 60_000
    });
    await expect(page.getByText("Module settings unavailable.", { exact: true })).toHaveCount(0);
    // Reach the catalog from the actual shell navigation.
    await page.goto(`${origin}/today`);
    if (width === 390)
      await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await page.getByRole("link", { name: "Modules", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Modules", exact: true })).toBeVisible({
      timeout: 60_000
    });
    const installed = page.locator("article.catalog-row[data-module=catalog-notes]");
    await expect(installed).toContainText("Moss registry · 1.0.0");
    await expect(installed).toContainText("Update available");
    await expect(page.getByText("Server controls", { exact: true })).toHaveCount(
      role === "admin" ? 1 : 0
    );
    await expect(page.getByRole("button", { name: "Module management settings" })).toHaveCount(
      role === "admin" ? 1 : 0
    );
    const choice = page.getByRole("checkbox", { name: "Notes on for you", exact: true });
    await expect(choice).toBeChecked();
    await choice.locator("..").click();
    await expect(page.getByText("Off for you", { exact: true })).toBeVisible();
    await page.reload();
    await expect(choice).not.toBeChecked({ timeout: 60_000 });
    const other = role === "admin" ? member : admin;
    const theirs = await (
      await other.request.get(`${origin}/api/modules/catalog-notes/account-switch`)
    ).json();
    assert.equal(theirs.enabled, true, "other account switch unchanged");
    await choice.locator("..").click();
    await expect(choice).toBeEnabled();
    await expect(choice).toBeChecked();
    if (role === "admin") {
      await page.getByText("Server controls", { exact: true }).click();
      const serverChoice = page.getByRole("checkbox", {
        name: "Notes on for everyone",
        exact: true
      });
      await expect(serverChoice).toBeChecked();
      await serverChoice.locator("..").click();
      await expect(installed).toContainText("Off for everyone");
      await page.reload();
      await page.getByText("Server controls", { exact: true }).click();
      await expect(serverChoice).not.toBeChecked();
      await serverChoice.locator("..").click();
      await expect(installed).not.toContainText("Off for everyone");
      await page.getByText("Server controls", { exact: true }).click();
      await expect(serverChoice).toBeChecked();
      await expect(page.getByRole("link", { name: "Export", exact: true })).toHaveAttribute(
        "href",
        "/api/modules/list/export"
      );
      await expect(page.getByRole("link", { name: "Import", exact: true })).toHaveAttribute(
        "href",
        "/settings/modules/registries#import"
      );
      assert.equal((await context.request.get(`${origin}/api/modules/list/export`)).status(), 200);
      await page.getByText("Server controls", { exact: true }).click();
    }
    await page.screenshot({ path: join(out, `${role}-${width}-installed.png`), fullPage: true });
    await browse(page);
    await filters(page);
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      "no horizontal overflow"
    );
    await page.screenshot({ path: join(out, `${role}-${width}-browse.png`), fullPage: true });
    await page.getByRole("link", { name: "Notes", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Notes", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "What it can touch" })).toBeVisible();
    if (role === "admin") {
      await page.getByRole("button", { name: "Pin 1.0.0", exact: true }).click();
      await expect(page.getByRole("button", { name: "Unpin", exact: true })).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Unpin", exact: true }).click();
      await expect(page.getByRole("button", { name: "Pin 1.0.0", exact: true })).toBeVisible();
    }
    await expect(page.getByRole("heading", { name: "What’s new" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recently" })).toBeVisible();
    await expect(
      page.getByRole("listitem").filter({ hasText: "Store and read this module's data" })
    ).toHaveCount(1);
    await expect(page.getByText("Today · Moss registry", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Registry notice: Publisher maintenance notice", { exact: true })
    ).toBeVisible();
    await expect(page.getByText(/Preview 1 of 2/)).toBeVisible();
    await expect(page.locator("img.catalog-preview")).toHaveJSProperty("naturalWidth", 1440);
    await page.getByRole("button", { name: "Next screenshot" }).click();
    await expect(page.getByText(/Preview 2 of 2/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Next screenshot" })).toBeDisabled();
    await page.getByRole("button", { name: "Previous screenshot" }).click();
    await expect(page.getByText(/Preview 1 of 2/)).toBeVisible();
    await page.screenshot({ path: join(out, `${role}-${width}-detail.png`), fullPage: true });
    await expect(page.getByText("Moss · Moss registry · 1.0.0", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Notes settings", exact: true }).click();
    await expect(page).toHaveURL(`${origin}/catalog-notes-settings`);
    await expect(
      page
        .frameLocator("iframe.module-screen")
        .frameLocator("iframe")
        .getByRole("heading", { name: "Notes settings" })
    ).toBeVisible();
    console.log(
      `PASS ${role} ${width}: shell navigation, filters/no-results, own switch reload, screenshot paging, settings cog, overflow`
    );
    // Slow the real transport, then remove real source configuration for the error path.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 900,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await page.goto(`${origin}/settings/modules?view=browse`, { waitUntil: "domcontentloaded" });
    await expect(page.getByText("Checking registries…", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Browse", exact: true })).toBeVisible({
      timeout: 60_000
    });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    const config = join(instance, "registry.json");
    renameSync(config, config + ".held");
    try {
      await page.goto(`${origin}/settings/modules`);
      await expect(
        page.getByText("Registry configuration is offline.", { exact: true })
      ).toBeVisible({
        timeout: 60_000
      });
      await expect(
        page.getByRole("checkbox", { name: "Notes on for you", exact: true }).locator("..")
      ).toBeVisible();
      await page.screenshot({ path: join(out, `${role}-${width}-error.png`), fullPage: true });
    } finally {
      renameSync(config + ".held", config);
    }
    await cdp.send("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByText("Modules could not be read.", { exact: true })).toBeVisible();
    await page.screenshot({
      path: join(out, `${role}-${width}-transport-error.png`),
      fullPage: true
    });
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page.getByRole("checkbox", { name: "Notes on for you", exact: true }).locator("..")
    ).toBeVisible({ timeout: 60_000 });
    console.log(
      `PASS ${role} ${width}: real transport loading, missing source configuration preserves installed list, Retry recovery`
    );
    await page.close();
  }
  for (const [role, context] of [
    ["admin", admin],
    ["member", member]
  ] as const)
    for (const width of [1440, 390]) await check(context, role, width);
  writeFileSync(
    join(out, "results.txt"),
    "PASS phase6_catalog_screens: admin/member × desktop/phone; search/source/category/first-party; no-results/loading/error/retry; account switch reload and isolation; signed screenshot paging; header cog; member admin-field exclusions.\n"
  );
  if (process.env.CATALOG_INSPECT === "1") {
    writeFileSync(join(hold, "inspect-ready"), origin);
    await waitFor(join(hold, "inspect-done"), 300_000);
  }
} finally {
  await browser?.close();
  writeFileSync(join(hold, "release"), "finished");
}
assert.equal(await exited, 0, "fixture completed");
