/** Disposable HTTPS/sign-in + installed Calendar with generated fixture credentials. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  openSync,
  closeSync
} from "node:fs";
import https from "node:https";
import { checkServerIdentity } from "node:tls";
import type { IncomingHttpHeaders } from "node:http";
import { networkInterfaces } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { chromium } from "@playwright/test";
import { getMossDatabaseUrls } from "@moss/db";
import { readHttpOracle } from "./http-oracle.js";
import { DEFAULT_LOCALE_SETTINGS, type CalendarEventDto } from "@moss/shared";
import { dateRangeLabel, dtoToViewEvent } from "../../../apps/web/src/calendar/calendar-model.js";

assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
const out = process.env.CALENDAR_HTTPS_PROOF_DIR;
assert(out, "Set a scratch CALENDAR_HTTPS_PROOF_DIR");
mkdirSync(out, { recursive: true, mode: 0o700 });
const port = Number(
  execFileSync("devports", ["claim", `js82-https-${process.pid}`], { encoding: "utf8" }).trim()
);
const local = `https://127.0.0.1:${port}`;
const address = Object.values(networkInterfaces())
  .flat()
  .find((n) => n?.family === "IPv4" && !n.internal)?.address;
assert(address, "A LAN interface is required");
const lan = `https://${address}:${port}`;
const origins = [local, `https://localhost:${port}`, lan];
const urls = getMossDatabaseUrls();
const credentials = join(out, "credentials.json");
const configuration = join(out, "network.json");
const certificate = join(out, "certificate.pem");
const key = join(out, "key.pem");
const fixture = join(out, "fixture.json");
const shared = process.env.CALENDAR_SHARED_DIR;
assert(shared, "Build shared module assets first");
const password = randomBytes(32).toString("hex");
writeFileSync(
  credentials,
  JSON.stringify({
    app_url: urls.app,
    auth_url: urls.auth,
    auth_secret: randomBytes(48).toString("hex"),
    connector_key: randomBytes(32).toString("hex")
  }),
  { mode: 0o600 }
);
writeFileSync(
  configuration,
  JSON.stringify({
    listen: `0.0.0.0:${port}`,
    origins,
    sharing: true,
    certificate,
    private_key: key,
    credentials
  }),
  { mode: 0o600 }
);
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-keyout",
    key,
    "-out",
    certificate,
    "-subj",
    "/CN=localhost",
    "-addext",
    `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${address}`
  ],
  { stdio: "ignore" }
);
// OpenSSL creates its key privately; enforce the network loader's explicit file contract.
execFileSync("chmod", ["600", key]);
const ca = readFileSync(certificate);
type Reply = { status: number; body: string; headers: IncomingHttpHeaders };
async function request(
  path: string,
  options: {
    base?: string;
    method?: string;
    body?: unknown;
    cookie?: string;
    headers?: Record<string, string>;
  } = {}
): Promise<Reply> {
  const base = options.base ?? local;
  const url = new URL(base);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((ok, fail) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port,
        path,
        method: options.method ?? "GET",
        ca,
        rejectUnauthorized: true,
        // Bind TLS verification to the connection URL even when testing a bad HTTP Host.
        servername: "localhost",
        checkServerIdentity: (_serverName, peerCertificate) =>
          checkServerIdentity(url.hostname, peerCertificate),
        headers: {
          ...(options.method ? { origin: base } : {}),
          ...(body
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
            : {}),
          ...(options.cookie ? { cookie: options.cookie } : {}),
          ...options.headers
        }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          ok({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString(),
            headers: response.headers
          })
        );
      }
    );
    // Unoptimized Rust scrypt can exceed 30s on a loaded development machine.
    const deadline = path === "/api/auth/sign-in/email" ? 120000 : 30000;
    req.setTimeout(deadline, () => req.destroy(new Error(`HTTPS deadline at ${path}`)));
    req.on("error", fail);
    req.end(body);
  });
}
const log = openSync(join(out, "https-server.log"), "w", 0o600);
const server = spawn(
  join(process.env.CARGO_TARGET_DIR ?? "/tmp/js72-host-target", "debug/examples/signed_ui"),
  [],
  {
    cwd: resolve("."),
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      JS48_APP_URL: urls.app,
      JS48_BOOTSTRAP_URL: urls.bootstrap,
      CALENDAR_NETWORK_CONFIG: configuration,
      CALENDAR_FIXTURE_INFO: fixture
    }
  }
);
const db = new pg.Client({ connectionString: urls.bootstrap });
let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
let completed = false;
try {
  await db.connect();
  let ready = false;
  for (let n = 0; n < 600; n++) {
    assert(server.exitCode === null, "HTTPS server exited; inspect the scratch server log");
    if (existsSync(fixture)) {
      try {
        ready = (await request("/sign-in")).status === 200;
      } catch {
        /* startup */
      }
    }
    if (ready) break;
    await delay(500);
  }
  assert(ready, "HTTPS listener startup timed out");
  const data: { actor: string; other: string; event: string; email: string; otherEmail: string } =
    JSON.parse(readFileSync(fixture, "utf8"));
  const salt = randomBytes(16).toString("hex");
  const hash = `${salt}:${scryptSync(password.normalize("NFKC"), salt, 64, { N: 16384, r: 16, p: 1, maxmem: 128 * 1024 * 1024 }).toString("hex")}`;
  for (const actor of [data.actor, data.other])
    await db.query(
      "INSERT INTO app.auth_accounts(id,account_id,provider_id,user_id,password) VALUES($1,$2,'credential',$3,$4)",
      [randomUUID(), actor, actor, hash]
    );
  assert.equal((await request("/calendar")).status, 303);
  assert.equal((await request("/api/m/calendar/events")).status, 401);
  const login = async (email: string, base = local) => {
    const r = await request("/api/auth/sign-in/email", {
      base,
      method: "POST",
      body: { email, password }
    });
    assert.equal(r.status, 200, "real Rust sign-in");
    const cookies = r.headers["set-cookie"] ?? [];
    assert(cookies.some((c) => c.includes("HttpOnly") && c.includes("Secure")));
    return cookies.map((c) => c.split(";")[0]).join("; ");
  };
  const owner = await login(data.email);
  const other = await login(data.otherEmail);
  const events = await request("/api/m/calendar/events", { cookie: owner });
  assert.equal(events.status, 200);
  assert(JSON.parse(events.body).events.some((e: { id: string }) => e.id === data.event));
  assert.equal(
    (await request(`/api/m/calendar/events/${data.event}`, { cookie: other })).status,
    404
  );
  for (const [actor, cookie] of [
    [data.actor, owner],
    [data.other, other]
  ]) {
    const paths = [
      "/api/calendar/events",
      `/api/calendar/events/${data.event}`,
      `/api/calendar/events/${randomUUID()}`,
      "/api/calendar/briefing-settings"
    ];
    const expected = await readHttpOracle(actor!, paths);
    for (const [index, path] of paths.entries()) {
      for (const url of [path, path.replace("/api/calendar/", "/api/m/calendar/")]) {
        const result = await request(url, { cookie });
        assert.deepEqual(
          { status: result.status, body: JSON.parse(result.body) },
          expected[index],
          `Signed installed read route differs from production at ${url}`
        );
      }
    }
  }
  assert.equal((await request("/api/calendar/events")).status, 401);
  assert.equal(
    (
      await request("/api/calendar/briefing-settings", {
        cookie: owner,
        method: "PATCH",
        body: { timeBlockMode: "auto" }
      })
    ).status,
    200,
    "The original settings URL exposes the installed PATCH route"
  );
  console.log(
    "PASS 16 signed HTTP comparisons against production read routes through both URL prefixes"
  );
  const foreign = await request("/api/m/calendar/events", { cookie: other });
  assert(!JSON.parse(foreign.body).events.some((e: { id: string }) => e.id === data.event));
  assert.equal(
    (
      await request("/api/m/calendar/display-settings", {
        cookie: owner,
        method: "PATCH",
        headers: { origin: "null" },
        body: { view: "month" }
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request("/api/m/calendar/events", {
        cookie: owner,
        headers: { host: `evil.example:${port}` }
      })
    ).status,
    421
  );
  const page = await request("/calendar", { cookie: owner });
  assert.equal(page.status, 200);
  const asset = page.body.match(/data-src="([^"]+)"/)?.[1];
  assert(asset);
  const staticReply = await request(asset, {
    headers: { origin: "null", "sec-fetch-site": "cross-site" }
  });
  assert.equal(staticReply.status, 200);
  assert.equal(staticReply.headers["access-control-allow-origin"], "null");
  assert(staticReply.headers["content-security-policy"]?.includes("sandbox allow-scripts"));
  assert(
    staticReply.headers["content-security-policy"]?.includes(
      `https://127.0.0.1:${port}/module-ui/calendar/`
    )
  );
  assert.equal(
    (await request("/api/network", { cookie: owner, method: "PUT", body: { sharing: false } }))
      .status,
    200
  );
  assert.equal((await request("/calendar", { base: lan, cookie: owner })).status, 403);
  assert.equal((await request(asset, { base: lan, headers: { origin: "null" } })).status, 403);
  assert.equal(
    (await request("/api/network", { cookie: owner, method: "PUT", body: { sharing: true } }))
      .status,
    200
  );
  const remote = await login(data.email, lan);
  assert.equal((await request("/calendar", { base: lan, cookie: remote })).status, 200);
  console.log(
    "PASS HTTPS sign-in, owner reads, foreign-account isolation, trusted origins, opaque static assets and same-machine LAN-address access"
  );
  // Real synthetic cache rows, read by the installed package. No network interception.
  const today = new Date().toISOString().slice(0, 10);
  const nextDay = (days: number) =>
    new Date(Date.parse(`${today}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  const proofEvents = [
    {
      id: randomUUID(),
      title: "Midnight date check",
      starts: `${today}T22:30:00Z`,
      ends: `${nextDay(1)}T00:00:00Z`,
      metadata: {}
    },
    {
      id: randomUUID(),
      title: "All-day date check",
      starts: `${today}T00:00:00Z`,
      ends: `${nextDay(3)}T00:00:00Z`,
      metadata: { allDay: true }
    },
    {
      id: randomUUID(),
      title: "Held block check",
      starts: `${today}T12:00:00Z`,
      ends: `${today}T13:00:00Z`,
      metadata: { jarvisCreated: true }
    }
  ];
  for (const event of proofEvents) {
    assert.equal(
      (
        await db.query(
          "INSERT INTO app.calendar_events(id,connector_account_id,owner_user_id,title,starts_at,ends_at,external_id,external_metadata) SELECT $2::uuid,connector_account_id,owner_user_id,$3,$4,$5,$2::text,$6 FROM app.calendar_events WHERE id=$1",
          [data.event, event.id, event.title, event.starts, event.ends, event.metadata]
        )
      ).rowCount,
      1
    );
  }
  // The task browser is visible in Herdr. Its own session is opened by the task's wrapper.
  const wrapper = "/home/ben/.local/bin/herdr-browser";
  const browserEnv = {
    ...process.env,
    AGENT_BROWSER_ARGS: "--no-sandbox,--force-prefers-reduced-motion"
  };
  execFileSync(wrapper, ["--ignore-https-errors", "open", `${local}/sign-in`], {
    stdio: "ignore",
    env: browserEnv
  });
  const cdp = execFileSync(wrapper, ["--ignore-https-errors", "get", "cdp-url"], {
    encoding: "utf8",
    env: browserEnv
  }).trim();
  browser = await chromium.connectOverCDP(cdp);
  const context = browser.contexts()[0];
  assert(context, "Task browser context is required");
  const tab = context.pages().find((p) => p.url().startsWith(local));
  assert(tab);
  await tab.setViewportSize({ width: 1280, height: 860 });
  await tab.getByLabel("Email").fill(data.email);
  await tab.getByLabel("Password").fill(password);
  await tab.getByRole("button", { name: "Sign in", exact: true }).click();
  await tab.waitForURL(`${local}/calendar`, { timeout: 120000 });
  await tab.goto(`${local}/calendar?event=${encodeURIComponent(data.event)}`);
  const frame = tab.frameLocator("#calendar");
  const screenshotDialog = async (filename: string) => {
    await frame.getByRole("dialog").evaluate(async (dialog) => {
      await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
    });
    await tab.screenshot({ path: join(out, filename) });
  };
  await frame.getByRole("dialog").filter({ hasText: "Calendar package check" }).waitFor();
  await screenshotDialog("signed-in-linked-event.png");
  await frame.getByRole("button", { name: "Close", exact: true }).click();
  for (const [index, event] of proofEvents.slice(0, 2).entries()) {
    const result = await request(`/api/calendar/events/${event.id}`, { cookie: owner });
    assert.equal(result.status, 200);
    const dto = JSON.parse(result.body).event as CalendarEventDto;
    const projected = dtoToViewEvent(dto, "UTC");
    assert(projected);
    const expected = dateRangeLabel(projected, { ...DEFAULT_LOCALE_SETTINGS, timezone: "UTC" });
    await tab.goto(`${local}/calendar?event=${event.id}`);
    await frame.getByRole("dialog").filter({ hasText: event.title }).waitFor();
    await frame.getByRole("dialog").getByText(expected, { exact: true }).waitFor();
    await screenshotDialog(
      index === 0 ? "signed-in-midnight-date.png" : "signed-in-all-day-dates.png"
    );
    await frame.getByRole("button", { name: "Close", exact: true }).click();
  }
  await frame
    .locator(".cal-legend__note")
    .getByText("Moss is holding 1 flexible block today.", { exact: true })
    .waitFor();
  for (const tone of ["hard", "hold"]) {
    const swatch = frame.locator(`.cal-legend__sw--${tone}`);
    const bounds = await swatch.boundingBox();
    assert(
      bounds && bounds.width > 0 && bounds.height > 0,
      "Shared event swatches must be visible"
    );
    assert.equal(
      await swatch.evaluate((el) => getComputedStyle(el).borderLeftStyle),
      tone === "hold" ? "dashed" : "solid"
    );
  }
  await tab.setViewportSize({ width: 390, height: 844 });
  assert(await frame.locator(".cal-legend__note").isVisible());
  await tab.screenshot({ path: join(out, "signed-in-day-legend-phone-width.png") });
  await frame.getByRole("button", { name: "Previous", exact: true }).click();
  await frame.locator(".cal-legend__note").waitFor({ state: "detached" });
  await frame.getByRole("button", { name: "Today", exact: true }).click();
  await frame.locator(".cal-legend__note").waitFor();
  await tab.setViewportSize({ width: 1280, height: 860 });
  console.log(
    "PASS installed UI midnight/all-day date labels against production, authored swatches and today's held count at desktop and phone width"
  );
  await frame.getByRole("button", { name: "Month", exact: true }).waitFor();
  await frame.getByRole("button", { name: "Month", exact: true }).click();
  await frame.locator(".cal-legend").waitFor({ state: "detached" });
  assert.equal(
    await frame.locator(".cal-month__grid").evaluate((el) => getComputedStyle(el).display),
    "grid",
    "The installed Calendar stylesheet must load in the opaque frame"
  );
  assert(
    await frame
      .locator("html")
      .evaluate((el) => getComputedStyle(el).getPropertyValue("--font-sans").trim()),
    "The shared Park Press stylesheet must load in the opaque frame"
  );
  await frame
    .getByRole("button", { name: /Calendar package check/ })
    .first()
    .click();
  await frame.getByRole("dialog").waitFor();
  await screenshotDialog("signed-in-event.png");
  await frame.getByRole("button", { name: "Close", exact: true }).click();
  await frame.getByRole("button", { name: "Week", exact: true }).click();
  await frame.locator(".cal-legend__note").waitFor({ state: "detached" });
  await frame.getByRole("button", { name: "Day", exact: true }).click();
  await tab.getByRole("link", { name: "Calendar settings", exact: true }).click();
  await frame.getByLabel("Look ahead", { exact: true }).waitFor();
  const saved = frame.getByRole("status").filter({ hasText: "Settings saved." });
  const saveSetting = async (label: string, value: string) => {
    const response = tab.waitForResponse(
      (r) =>
        r.url().endsWith("/api/m/calendar/briefing-settings") && r.request().method() === "PATCH"
    );
    await frame.getByLabel(label, { exact: true }).selectOption(value);
    assert.equal((await response).status(), 200);
    await saved.waitFor();
  };
  await saveSetting("Look ahead", "0");
  await saveSetting("Prep tasks", "off");
  await saveSetting("Time blocks", "suggest");
  const confirmed = await request("/api/calendar/briefing-settings", { cookie: owner });
  assert.equal(JSON.parse(confirmed.body).settings.lookaheadDays, 0);
  assert.equal(JSON.parse(confirmed.body).settings.prepTaskMode, "off");
  assert.equal(JSON.parse(confirmed.body).settings.timeBlockMode, "suggest");
  const policy = await db.query(
    "SELECT value_json FROM app.preferences WHERE owner_user_id=$1 AND key='assistant.action_policy.v1.calendar.calendar_writeback'",
    [data.actor]
  );
  assert.equal(policy.rows[0]?.value_json, "ask_each_time");
  await tab.reload();
  await frame.getByLabel("Look ahead", { exact: true }).waitFor();
  assert.equal(await frame.getByLabel("Look ahead", { exact: true }).inputValue(), "0");
  assert.equal(await frame.getByLabel("Prep tasks", { exact: true }).inputValue(), "off");
  assert.equal(await frame.getByLabel("Time blocks", { exact: true }).inputValue(), "suggest");
  await context.setOffline(true);
  await frame.getByLabel("Prep tasks", { exact: true }).selectOption("auto");
  await frame
    .getByRole("alert")
    .filter({ hasText: "Could not save calendar briefing settings" })
    .waitFor({ timeout: 120000 });
  assert.equal(await frame.getByLabel("Prep tasks", { exact: true }).inputValue(), "off");
  await context.setOffline(false);
  await saveSetting("Prep tasks", "auto");
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.screenshot({ path: join(out, "signed-in-settings-phone-width.png") });
  await tab.setViewportSize({ width: 1280, height: 860 });
  await tab.screenshot({ path: join(out, "signed-in-settings.png") });
  console.log(
    "PASS signed-in UI settings save/reload, stored writeback policy, failed-save retention and retry"
  );
  await tab.getByRole("link", { name: "Calendar", exact: true }).click();
  await frame
    .getByRole("button", { name: /Calendar package check/ })
    .first()
    .waitFor();
  await context.setOffline(true);
  await delay(31000);
  await frame.getByRole("alert").filter({ hasText: "Previously loaded events" }).waitFor();
  await context.setOffline(false);
  await frame.getByRole("button", { name: "Try again", exact: true }).click();
  await frame.getByRole("alert").waitFor({ state: "detached" });
  await tab.setViewportSize({ width: 390, height: 844 });
  await tab.screenshot({ path: join(out, "signed-in-phone-width.png") });
  // Change the real cache row: no network interception or response replacement.
  await frame
    .getByRole("button", { name: /Calendar package check/ })
    .first()
    .click();
  await db.query(
    "UPDATE app.calendar_events SET title='Updated calendar meeting', external_metadata='{\"attendeeCount\":1}' WHERE id=$1",
    [data.event]
  );
  await frame
    .getByRole("dialog")
    .filter({ hasText: "Updated calendar meeting" })
    .waitFor({ timeout: 120000 });
  await frame.getByRole("dialog").getByText("1 person", { exact: true }).waitFor();
  await screenshotDialog("signed-in-updated-event.png");
  await db.query("DELETE FROM app.calendar_events WHERE id=$1", [data.event]);
  await frame.getByRole("dialog").waitFor({ state: "detached", timeout: 120000 });
  assert.equal(await frame.getByRole("button", { name: /Updated calendar meeting/ }).count(), 0);
  console.log(
    "PASS event deep link, updated open details and dismissal after actual cached-event removal"
  );
  const previousCookie = (await context.cookies(local))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  assert(previousCookie, "Browser sign-in must have a session cookie");
  await tab.getByRole("button", { name: "Sign out", exact: true }).click();
  await tab.waitForURL(`${local}/sign-in`);
  assert.equal(
    (await request("/api/m/calendar/events", { cookie: previousCookie })).status,
    401,
    "signed-out browser session is revoked"
  );
  assert.equal(
    (await request("/api/m/calendar/events", { cookie: owner })).status,
    200,
    "API owner's separate session still works"
  );
  console.log(
    "PASS real browser sign-in, installed Day/Week/Month, event details, settings, retained data after failure, retry, phone-width layout and sign-out"
  );
  writeFileSync(
    join(out, "result.txt"),
    "PASS: real Rust HTTPS sign-in, installed Calendar screens, midnight/all-day dates compared with production UI, Day held-block count and shared swatches at desktop/phone width, event deep links, live detail refresh/removal, production read-route comparisons, settings save/reload/failure/retry and writeback policy, account isolation, static asset CSP/CORS, origin checks, LAN-address path, failure/retry and sign-out.\nNot proven: physical second device, production TLS trust, regional formatting beyond default English, full shell/chat, provider writes/jobs and full Calendar parity.\n"
  );
  completed = true;
  if (process.env.CALENDAR_BROWSER_HOLD === "1") {
    console.log("READY for task browser inspection; create the configured done sentinel to stop");
    const done = process.env.CALENDAR_BROWSER_DONE;
    assert(done);
    for (let n = 0; n < 1800 && !existsSync(done); n++) await delay(1000);
  }
} finally {
  if (browser) await browser.close();
  await db.end();
  server.kill("SIGINT");
  await new Promise<void>((ok) => {
    if (server.exitCode !== null) ok();
    else server.once("exit", () => ok());
  });
  closeSync(log);
  for (const file of [credentials, key, configuration]) rmSync(file, { force: true });
  execFileSync("devports", ["release", String(port)], { stdio: "ignore" });
  if (completed) {
    assert.equal(server.exitCode, 0, "HTTPS fixture stops cleanly");
    assert(!readFileSync(join(out, "https-server.log"), "utf8").includes("panicked at"));
  }
}
