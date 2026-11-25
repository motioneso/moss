/** Real dev instance, signed registry mutations and real host operations. No response interception. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
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
const out = process.env.TRUST_OUT ?? "/tmp/js421/proof";
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
    "phase6_trust_screens",
    "phase6_trust_screens",
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
      TRUST_SCREENS: "1",
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
  const {
    origin,
    instance,
    member: memberId,
    admin: adminId,
    extraKey
  } = JSON.parse(readFileSync(join(hold, "ready.json"), "utf8")) as {
    origin: string;
    instance: string;
    member: string;
    admin: string;
    extraKey: string;
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
  const admin = await person("bootstrap-owner@example.test");
  const member = await person("policy-member@example.test");
  const other = await person("second-member@example.test");
  let commandId = 0;
  async function command(action: string, width: string) {
    rmSync(join(hold, "reply"), { force: true });
    writeFileSync(join(hold, "command.next"), JSON.stringify({ action, width, id: ++commandId }));
    renameSync(join(hold, "command.next"), join(hold, "command.json"));
    await waitFor(join(hold, "reply"), 30_000);
    assert.equal(JSON.parse(readFileSync(join(hold, "reply"), "utf8")), commandId);
  }
  async function post(path: string, data: unknown) {
    const response = await admin.request.post(`${origin}${path}`, { headers: { origin }, data });
    assert(response.ok(), `${path}: ${response.status()}`);
    return response.json();
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
  assert.equal(
    (await admin.request.get(`${origin}/api/modules/catalog-view`)).status(),
    200,
    "refresh signed fixture offers"
  );
  // Independent real refusal probes also make guard-removal controls observable in one run.
  const controlErrors: string[] = [];
  async function control(name: string, check: () => Promise<void>) {
    try {
      await check();
      console.log(`PASS guard probe: ${name}`);
    } catch (error) {
      controlErrors.push(`${name}: ${String(error)}`);
      console.error(`FAIL guard probe: ${name}: ${String(error)}`);
    }
  }
  const controlPackage = readFileSync(join(hold, "import-control.mosspkg")).toString("base64");
  await control("package administrator check", async () => {
    const r = await member.request.post(`${origin}/api/modules/packages/import`, {
      headers: { origin },
      data: {
        source: "moss-fixture",
        package: controlPackage,
        signature: readFileSync(join(hold, "import-control.sig"), "utf8")
      }
    });
    assert.equal(r.status(), 403);
  });
  await control("trusted package signature", async () => {
    const r = await admin.request.post(`${origin}/api/modules/packages/import`, {
      headers: { origin },
      data: {
        source: "moss-fixture",
        package: controlPackage,
        signature: readFileSync(join(hold, "wrong-control.sig"), "utf8")
      }
    });
    assert.equal(r.status(), 422);
  });
  const requestControl = await member.request.post(`${origin}/api/modules/requests`, {
    headers: { origin },
    data: { source: "moss-fixture", module: "decline-control" }
  });
  assert.equal(requestControl.status(), 200);
  const controlRequest = await requestControl.json();
  await control("decline administrator check", async () => {
    const r = await member.request.post(
      `${origin}/api/modules/requests/${controlRequest.id}/decline`,
      { headers: { origin }, data: {} }
    );
    assert.equal(r.status(), 403);
  });
  await post(`/api/modules/requests/${controlRequest.id}/decline`, {});
  const privateBytes = readFileSync(join(hold, "local-control.mosspkg")).toString("base64");
  await control("local builder owner check", async () => {
    const r = await other.request.post(`${origin}/api/modules/local/review`, {
      headers: { origin },
      data: { package: privateBytes }
    });
    assert.equal(r.status(), 422);
  });
  const signedControl = await member.request.post(`${origin}/api/modules/local/review`, {
    headers: { origin },
    data: { package: privateBytes }
  });
  assert.equal(signedControl.status(), 200);
  const signatureControl = (await signedControl.json()).signature;
  const installControl = await member.request.post(`${origin}/api/modules/local/install`, {
    headers: { origin },
    data: { package: privateBytes, signature: signatureControl, approve: true }
  });
  assert.equal(installControl.status(), 200, "real control local installation");
  await control("local provenance visibility", async () => {
    for (const actor of [other, admin]) {
      const r = await actor.request.get(
        `${origin}/api/modules/trust/local.${memberId}.trust-control`
      );
      assert.equal(r.status(), 404);
    }
  });
  assert.deepEqual(controlErrors, [], "all real access and trust guards");
  const fingerprint = createHash("sha256").update(Buffer.from(extraKey, "base64")).digest("hex");
  for (const [width, pixels] of process.env.TRUST_GUARDS_ONLY === "1"
    ? []
    : ([
        ["desktop", 1440],
        ["phone", 390]
      ] as const)) {
    const page = await admin.newPage();
    const memberPage = await member.newPage();
    await page.setViewportSize({ width: pixels, height: 1000 });
    await memberPage.setViewportSize({ width: pixels, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    memberPage.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`${origin}/settings/modules`);
    await page.getByRole("link", { name: "Registries", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Registries", exact: true })).toBeVisible();
    await page.getByLabel("Registry ID", { exact: true }).fill(`folder-${width}`);
    await page
      .getByLabel("Address or folder", { exact: true })
      .fill(join(instance, `folder-${width}`));
    await page.getByLabel("Root public key", { exact: true }).fill(extraKey);
    await page.getByRole("button", { name: "Check registry", exact: true }).click();
    let dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(fingerprint);
    const sources = await (await admin.request.get(`${origin}/api/modules/registries`)).json();
    assert.equal(
      sources.registries.find((r: { id: string }) => r.id === `folder-${width}`).confirmed,
      false,
      "check does not save trust"
    );
    const wrongFingerprint = await admin.request.post(
      `${origin}/api/modules/registries/folder-${width}/confirm`,
      { headers: { origin }, data: { fingerprint: "0".repeat(64) } }
    );
    assert.equal(wrongFingerprint.status(), 422, "actual root must be confirmed");
    const configured = JSON.parse(readFileSync(join(instance, "registry.json"), "utf8"));
    assert(
      !configured.registries.some((r: { id: string }) => r.id === `folder-${width}`),
      "pending root excluded from trusted configuration"
    );
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-fingerprint.png`) });
    await dialog.getByRole("button", { name: "Trust and add", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(`[data-registry="folder-${width}"]`)).toContainText("Root confirmed");

    const importBytes = readFileSync(join(hold, `import-${width}.mosspkg`)).toString("base64");
    const importSignature = readFileSync(join(hold, `import-${width}.sig`), "utf8");
    async function packageStorage() {
      const files: Record<string, string> = {};
      function walk(path: string) {
        if (!existsSync(path)) return;
        for (const name of readdirSync(path)) {
          const file = join(path, name);
          if (statSync(file).isDirectory()) walk(file);
          else files[file] = createHash("sha256").update(readFileSync(file)).digest("hex");
        }
      }
      for (const dir of ["blobs", "installed", "staging"]) walk(join(instance, "modules", dir));
      await command("storage", width);
      return { files, catalog: readFileSync(join(hold, "catalog-digest"), "utf8") };
    }
    const untouched = await packageStorage();
    for (const actor of [member, other]) {
      const denied = await actor.request.post(`${origin}/api/modules/packages/import`, {
        headers: { origin },
        data: {
          source: "moss-fixture",
          package: importBytes,
          signature: importSignature,
          approve: true
        }
      });
      assert.equal(denied.status(), 403, "non-admin package import refused");
      assert.deepEqual(await packageStorage(), untouched, "non-admin wrote no package bytes");
    }
    const wrong = await admin.request.post(`${origin}/api/modules/packages/import`, {
      headers: { origin },
      data: {
        source: "moss-fixture",
        package: importBytes,
        signature: readFileSync(join(hold, `wrong-${width}.sig`), "utf8"),
        approve: true
      }
    });
    assert.equal(wrong.status(), 422, "wrong package signature refused");
    assert.deepEqual(await packageStorage(), untouched, "wrong signature wrote no package bytes");
    await page.getByLabel("Source", { exact: true }).selectOption("moss-fixture");
    await page
      .getByLabel("Package and signature", { exact: true })
      .setInputFiles([join(hold, `import-${width}.mosspkg`), join(hold, `wrong-${width}.sig`)]);
    await page.getByRole("button", { name: "Review package", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Package refused");
    await page
      .getByLabel("Package and signature", { exact: true })
      .setInputFiles([join(hold, `import-${width}.mosspkg`), join(hold, `import-${width}.sig`)]);
    await page.getByRole("button", { name: "Review package", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Install import ${width}`);
    await fits(page);
    assert.deepEqual(await packageStorage(), untouched, "review stores no package bytes");
    await page.screenshot({ path: join(out, `${width}-file-review.png`) });
    await dialog.getByRole("button", { name: "Install package", exact: true }).click();
    await expect(page.getByText("Package installed.", { exact: true })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-registries.png`) });
    console.log(
      `PASS ${width}: folder and package file import, wrong signature and non-admin refused without writes, root confirmed before trust saved`
    );

    const module = `request-${width}`;
    await memberPage.goto(`${origin}/settings/modules?view=browse`);
    await memberPage.getByRole("link", { name: module, exact: true }).click();
    await memberPage.getByRole("link", { name: "Request to install", exact: true }).click();
    await memberPage.getByRole("button", { name: "Ask an admin", exact: true }).click();
    await expect(memberPage.getByText("Waiting for an admin", { exact: true })).toBeVisible();
    const requests = await (await member.request.get(`${origin}/api/modules/requests`)).json();
    const requested = requests.requests.find((r: { module: string }) => r.module === module);
    assert(requested);
    await memberPage.reload();
    await expect(memberPage.getByText("Waiting for an admin", { exact: true })).toBeVisible();
    await page.goto(`${origin}/settings/modules`);
    const row = page.locator(`[data-request="${requested.id}"]`);
    await expect(page.getByText("1 pending request", { exact: true })).toBeVisible();
    await expect(row).toContainText(module);
    await row.getByRole("link", { name: "Review", exact: true }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(`Install ${module}`);
    await dialog.getByRole("button", { name: `Install ${module}`, exact: true }).click();
    await expect(
      page.getByRole("heading", { name: `${module} is ready`, exact: true })
    ).toBeVisible();
    await memberPage.getByRole("button", { name: "Check status", exact: true }).click();
    await expect(memberPage.getByText("Approved and installed", { exact: true })).toBeVisible();
    await fits(memberPage);
    await memberPage.screenshot({ path: join(out, `${width}-request-approved.png`) });

    const decline = await member.request.post(`${origin}/api/modules/requests`, {
      headers: { origin },
      data: { module: `decline-${width}`, source: "moss-fixture" }
    });
    assert.equal(decline.status(), 200);
    const declinedRequest = await decline.json();
    for (const actor of [member, other]) {
      const refused = await actor.request.post(
        `${origin}/api/modules/requests/${declinedRequest.id}/decline`,
        { headers: { origin }, data: {} }
      );
      assert.equal(refused.status(), 403, "both non-admins refused decline");
    }
    await page.goto(`${origin}/settings/modules`);
    await page
      .locator(`[data-request="${declinedRequest.id}"]`)
      .getByRole("button", { name: "Decline", exact: true })
      .click();
    await expect(page.locator(`[data-request="${declinedRequest.id}"]`)).toContainText("Declined");
    const declined = await (
      await member.request.get(`${origin}/api/modules/requests/${declinedRequest.id}`)
    ).json();
    assert.equal(declined.status, "declined");
    assert.equal(declined.declinedBy, adminId, "recorded deciding administrator");
    assert(Number.isFinite(Date.parse(declined.declinedAt)), "recorded decision time");
    const repeated = await post(`/api/modules/requests/${declinedRequest.id}/decline`, {});
    assert.equal(repeated.declinedAt, declined.declinedAt, "decline is idempotent");
    const review = await post("/api/modules/review", {
      module: `decline-${width}`,
      source: "moss-fixture"
    });
    const approvedDeclined = await admin.request.post(
      `${origin}/api/modules/requests/${declinedRequest.id}/approve`,
      { headers: { origin }, data: { approve: true, operation: review.id } }
    );
    assert.equal(approvedDeclined.status(), 409, "decline cannot later activate");
    await memberPage.goto(
      `${origin}/settings/modules?module=decline-${width}&source=moss-fixture&screen=request`
    );
    await expect(memberPage.getByText("Declined", { exact: true })).toBeVisible();
    await memberPage.screenshot({ path: join(out, `${width}-request-declined.png`) });
    console.log(
      `PASS ${width}: member request to reviewed admin installation; pending queue; decline actor/time visible to member, two non-admin refusals`
    );

    const bytes = readFileSync(join(hold, `local-${width}.mosspkg`)).toString("base64");
    const localId = `local.${memberId}.trust-${width}`;
    for (const actor of [other, admin]) {
      const denied = await actor.request.post(`${origin}/api/modules/local/review`, {
        headers: { origin },
        data: { package: bytes }
      });
      assert.equal(denied.status(), 422, "non-builder including admin refused review");
    }
    await memberPage.goto(`${origin}/settings/modules`);
    await memberPage.getByRole("link", { name: "Local package", exact: true }).click();
    await memberPage
      .getByLabel("Built package", { exact: true })
      .setInputFiles(join(hold, `local-${width}.mosspkg`));
    await memberPage.getByRole("button", { name: "Sign and review", exact: true }).click();
    dialog = memberPage.getByRole("dialog");
    await expect(dialog).toContainText("Not registry-reviewed");
    await fits(memberPage);
    await memberPage.screenshot({ path: join(out, `${width}-local-review.png`) });
    // Use this real signed review to exercise the install route's independent owner check.
    const localReply = await member.request.post(`${origin}/api/modules/local/review`, {
      headers: { origin },
      data: { package: bytes }
    });
    assert.equal(localReply.status(), 200);
    const localReview = await localReply.json();
    for (const actor of [other, admin]) {
      const denied = await actor.request.post(`${origin}/api/modules/local/install`, {
        headers: { origin },
        data: { package: bytes, signature: localReview.signature, approve: true }
      });
      assert.equal(denied.status(), 422, "non-builder including admin refused installation");
    }
    await dialog.getByRole("button", { name: "Install local package", exact: true }).click();
    await expect(memberPage.getByText("Local package installed.", { exact: true })).toBeVisible();
    await memberPage.getByRole("link", { name: "Local provenance", exact: true }).click();
    await expect(
      memberPage.getByText("Private to you · Signed on this server", { exact: true })
    ).toBeVisible();
    await expect(memberPage.getByText(localReview.digest, { exact: true })).toBeVisible();
    await expect(memberPage.getByText(localReview.fingerprint, { exact: true })).toBeVisible();
    await fits(memberPage);
    await memberPage.screenshot({ path: join(out, `${width}-local-provenance.png`) });
    for (const actor of [other, admin]) {
      const trust = await actor.request.get(`${origin}/api/modules/trust/${localId}`);
      assert.equal(trust.status(), 404, "private provenance invisible");
      for (const path of ["/api/modules/catalog-view", "/api/modules/navigation"]) {
        const response = await actor.request.get(`${origin}${path}`);
        assert.equal(response.status(), 200);
        const body = await response.text();
        assert(
          !body.includes(localId) && !body.includes(`Private ${width}`),
          `private package absent from ${path}`
        );
      }
      const hidden = await actor.newPage();
      await hidden.setViewportSize({ width: pixels, height: 1000 });
      await hidden.goto(`${origin}/settings/modules?module=${localId}&screen=trust`);
      await expect(hidden.getByText("Package details unavailable.", { exact: true })).toBeVisible();
      assert(!(await hidden.locator("main").innerText()).includes(`Private ${width}`));
      await hidden.close();
    }
    const tampered = await member.request.post(`${origin}/api/modules/local/install`, {
      headers: { origin },
      data: {
        package: Buffer.from("changed bytes").toString("base64"),
        signature: localReview.signature,
        approve: true
      }
    });
    assert.equal(tampered.status(), 422, "signature binds reviewed bytes");
    console.log(
      `PASS ${width}: builder signs/reviews/installs; another account and admin refused, package absent from their catalog, navigation and provenance`
    );

    await command("notices", width);
    await post("/api/modules/refresh", {});
    await page.goto(`${origin}/settings/modules?module=catalog-notes&source=moss-fixture`);
    await page.getByRole("link", { name: "Registry notice", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Notes is blocked", exact: true })
    ).toBeVisible();
    await expect(page.getByText("Publisher key revoked.", { exact: true })).toBeVisible();
    await expect(page.getByText("Kept", { exact: true })).toBeVisible();
    await fits(page);
    await page.screenshot({ path: join(out, `${width}-blocked.png`) });
    await page.goto(`${origin}/settings/modules?module=${module}&source=moss-fixture`);
    await page.getByRole("link", { name: "Registry notice", exact: true }).click();
    await expect(page.getByText("Still running", { exact: true })).toBeVisible();
    await expect(page.getByText("Publisher review pending.", { exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, `${width}-warning.png`) });
    await command("offline", width);
    await post("/api/modules/refresh", {});
    await page.goto(`${origin}/settings/modules?view=browse`);
    await expect(page.getByText("Moss registry is offline.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Notes", exact: true })).toBeVisible();
    await page.screenshot({ path: join(out, `${width}-offline-cache.png`) });
    await page.goto(
      `${origin}/settings/modules?module=catalog-notes&source=moss-fixture&screen=trust`
    );
    await expect(page.getByText("Publisher key revoked.", { exact: true })).toBeVisible();
    await command("online", width);
    assert.deepEqual(errors, [], "no browser exceptions");
    await page.close();
    await memberPage.close();
    console.log(
      `PASS ${width}: signed block and warn reasons, cached catalog and persisted block offline`
    );
  }
  if (process.env.TRUST_INSPECT === "1") {
    writeFileSync(join(hold, "inspection-ready"), origin);
    console.log("Trust fixture ready for task browser", origin);
    await waitFor(join(hold, "inspection-complete"), 600_000);
  }
  await admin.close();
  await member.close();
  await other.close();
  console.log("PASS phase6_trust_screens: desktop and phone real host operations", out);
} finally {
  await browser?.close();
  writeFileSync(join(hold, "release"), "done");
  assert.equal(await exited, 0, "real fixture completed");
}
