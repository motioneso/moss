/**
 * Live proof for the Today hero briefing note. Run through hero-live.sh and verify-gate.
 *
 * Starts the Briefings live test in held-open mode (real Rust server over HTTPS, the real shell
 * web build, two people, a stand-in model), then drives Today in a real browser. Nothing is
 * intercepted or rewritten. HERO_REMOVE_PROTECTION=1 turns off row security on the briefing
 * tables in the disposable database to show the cross-account check can fail.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";
import { getMossDatabaseUrls } from "../../../packages/db/src/urls.js";

if (process.env.JARVIS_GATE_RUN !== "1") throw new Error("Use verify-gate");
for (const name of ["CARGO_TARGET_DIR", "HERO_WEB", "HERO_OUT"]) {
  if (!process.env[name]) throw new Error(`Set ${name}`);
}
const target = process.env.CARGO_TARGET_DIR!;
const out = process.env.HERO_OUT!;
mkdirSync(out, { recursive: true });
const removeProtection = process.env.HERO_REMOVE_PROTECTION === "1";
const urls = getMossDatabaseUrls();
const hold = join(out, "hold.json");
const password = "temporary-briefings-password-263-not-a-real-secret";

const test = spawn(
  "cargo",
  [
    "+1.95.0",
    "test",
    "--offline",
    "--locked",
    "--manifest-path",
    "rust-spike/module-host/Cargo.toml",
    "--test",
    "briefings_server",
    "--",
    "--ignored",
    "--nocapture"
  ],
  {
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      BRIEFINGS_HOLD_OPEN: hold,
      BRIEFINGS_WEB: process.env.HERO_WEB,
      JS43_APP_URL: urls.app,
      JS43_WORKER_URL: urls.worker,
      JS43_BOOTSTRAP_URL: urls.bootstrap,
      JS170_AUTH_URL: urls.auth,
      JS170_SERVER: join(target, "debug/moss-server"),
      JS170_CERTIFICATE: join(target, "debug/moss-network")
    }
  }
);
let testExit: number | null = null;
test.on("exit", (code) => (testExit = code ?? 1));

async function waitFor(path: string, ms = 900_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (existsSync(path)) return;
    if (testExit !== null) throw new Error(`Briefings live test ended early (${testExit})`);
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

type Hold = { origin: string; cookie: string; otherCookie: string };
let failure: unknown;
try {
  await waitFor(hold);
  const { origin } = JSON.parse(readFileSync(hold, "utf8")) as Hold;
  const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
  const makePerson = async (email: string) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const signIn = await context.request.post(`${origin}/api/auth/sign-in/email`, {
      headers: { origin },
      data: { email, password }
    });
    assert.equal(signIn.status(), 200, `sign-in ${email}`);
    return context;
  };
  const owner = await makePerson("briefings-owner@example.test");
  const other = await makePerson("briefings-other@example.test");
  const api = (
    who: APIRequestContext,
    method: "get" | "post" | "patch",
    path: string,
    data?: object
  ) => who[method](`${origin}/api/m/briefings${path}`, { headers: { origin }, data });

  const note = async (page: Page, shot: string) => {
    await page.goto(`${origin}/`);
    await page.locator(".today-hero__title").waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle");
    await delay(1500);
    for (const [label, size] of [
      ["desktop", { width: 1440, height: 900 }],
      ["phone", { width: 390, height: 844 }]
    ] as const) {
      await page.setViewportSize(size);
      await page.locator(".today-hero").screenshot({ path: join(out, `${shot}-${label}.png`) });
    }
    const spans = page.locator(".today-hero__not-ready");
    return (await spans.count()) === 0 ? null : (await spans.first().innerText()).trim();
  };
  const ownerPage = await owner.newPage();
  const otherPage = await other.newPage();
  const failedCalls: string[] = [];
  for (const p of [ownerPage, otherPage]) {
    p.on("response", (r) => {
      if (r.url().startsWith(origin) && r.status() >= 500)
        failedCalls.push(`${r.status()} ${r.url()}`);
    });
  }

  // The server answers 503 until its module host has started.
  for (let i = 0; i < 120; i++) {
    if ((await api(owner.request, "get", "/definitions")).status() !== 503) break;
    await delay(500);
  }
  const defs = (await (await api(owner.request, "get", "/definitions")).json()).definitions as {
    id: string;
    briefingType: string;
  }[];
  const morning = defs.find((d) => d.briefingType === "morning");
  assert(morning, "the live test left the owner a morning briefing");

  // 1. A switched-on morning briefing with a finished run today hides the note.
  const ready = await note(ownerPage, "owner-readable-run");
  console.log(`owner with a readable run: ${JSON.stringify(ready)}`);
  assert.equal(ready, null, "a readable run hides the note");

  // 2. The other person has their own switched-on briefing and no run. Owner's record is
  // touched last, so it is the newest definition if row security stops separating people.
  const created = await api(other.request, "post", "/definitions", {
    title: "Other morning",
    briefingType: "morning",
    cadence: "daily"
  });
  assert.equal(created.status(), 201, "other person saves a morning briefing");
  const touch = await api(owner.request, "patch", `/definitions/${morning.id}`, { enabled: true });
  assert.equal(touch.status(), 200, "owner record touched");
  if (removeProtection) {
    const db = new pg.Client({ connectionString: urls.bootstrap });
    await db.connect();
    await db.query("ALTER TABLE app.briefing_definitions DISABLE ROW LEVEL SECURITY");
    await db.query("ALTER TABLE app.briefing_runs DISABLE ROW LEVEL SECURITY");
    await db.end();
    console.log("PROTECTION REMOVED: row security off on briefing tables");
  }
  const theirs = await note(otherPage, "other-no-run");
  console.log(`other person, own briefing, no run: ${JSON.stringify(theirs)}`);
  assert(
    theirs !== null && /^It (runs|should have run) at /.test(theirs),
    "the other person's hero shows their own schedule, not the owner's run"
  );

  // 3. Switching the owner's briefing off shows the off line.
  const off = await api(owner.request, "patch", `/definitions/${morning.id}`, { enabled: false });
  assert.equal(off.status(), 200, "owner switches the briefing off");
  const offNote = await note(ownerPage, "owner-switched-off");
  console.log(`owner switched off: ${JSON.stringify(offNote)}`);
  assert.equal(offNote, "Your morning briefing is switched off.");

  assert.deepEqual(failedCalls, [], "no server errors during the proof");
  console.log("HERO LIVE PASS");
  await browser.close();
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  writeFileSync(`${hold}.stop`, "");
  await Promise.race([new Promise((done) => test.on("exit", done)), delay(60_000)]);
  test.kill();
}
process.exit(failure ? 1 : 0);
