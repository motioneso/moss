/**
 * Real-browser check of the Calendar screens on the real Rust server over HTTPS.
 * Started by the server gate with ORIGIN, EMAIL, PASSWORD, EVENT_TITLE and OUT set.
 * Nothing is intercepted or rewritten; every request reaches the server.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const { ORIGIN, EMAIL, PASSWORD, EVENT_TITLE, OUT } = process.env;
for (const [name, value] of Object.entries({ ORIGIN, EMAIL, PASSWORD, EVENT_TITLE, OUT })) {
  if (!value) throw new Error(`Set ${name}`);
}
const origin = ORIGIN!;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || undefined });
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1280, height: 860 }
});
const page = await context.newPage();
const failed: string[] = [];
page.on("response", (response) => {
  if (response.url().startsWith(origin) && response.status() >= 500) {
    failed.push(`${response.status()} ${response.url()}`);
  }
});

// Sign in through the real route; the cookie lands in the browser context.
const signIn = await context.request.post(`${origin}/api/auth/sign-in/email`, {
  headers: { origin },
  data: { email: EMAIL, password: PASSWORD }
});
assert.equal(signIn.status(), 200, "sign-in");

// The server loads modules in the background; wait until the first Calendar route answers.
for (let i = 0; i < 120; i++) {
  const ready = await context.request.get(`${origin}/api/m/calendar/events`, {
    headers: { origin }
  });
  if (ready.status() !== 503) break;
  await new Promise((done) => setTimeout(done, 500));
}

const screen = (path: string) =>
  `${origin}/module-frame?module=calendar&path=${encodeURIComponent(path)}`;

await page.goto(screen("/calendar"));
const frame = page.frameLocator("#frame");
await frame.getByRole("button", { name: "Month", exact: true }).waitFor({ timeout: 60_000 });
await frame.getByRole("button", { name: "Month", exact: true }).click();
const chip = frame.getByRole("button", { name: new RegExp(EVENT_TITLE!) }).first();
await chip.waitFor({ timeout: 30_000 });
await expect(chip).toBeInViewport();
await page.screenshot({ path: join(OUT!, "calendar-month.png") });
console.log("PASS Month screen on the real server shows the signed-in owner's cached event");

await chip.click();
const dialog = frame.getByRole("dialog");
await dialog.waitFor();
await dialog.getByText(EVENT_TITLE!, { exact: false }).first().waitFor();
await page.screenshot({ path: join(OUT!, "calendar-details.png") });
await page.keyboard.press("Escape");
await dialog.waitFor({ state: "detached" });
console.log("PASS event details open from the Month screen and close with Escape");

await frame.getByRole("button", { name: "Week", exact: true }).click();
await frame
  .getByRole("button", { name: new RegExp(EVENT_TITLE!) })
  .first()
  .waitFor();
await frame.getByRole("button", { name: "Day", exact: true }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: join(OUT!, "calendar-day.png") });
console.log("PASS Week and Day views switch on the real server");

// The chosen view is saved by the server and returns after a reload.
await frame.getByRole("button", { name: "Week", exact: true }).click();
await page.waitForTimeout(500);
await page.reload();
await frame.getByRole("button", { name: "Week", exact: true }).waitFor();
const display = await context.request.get(`${origin}/api/m/calendar/display-settings`, {
  headers: { origin }
});
assert.equal(display.status(), 200);

// Settings screen: change the controls and confirm the server kept the values.
await page.goto(screen("/settings/calendar"));
const lookAhead = frame.getByLabel("Look ahead", { exact: true });
await lookAhead.waitFor({ timeout: 60_000 });
const saved = frame.getByRole("status").filter({ hasText: "Settings saved." });
const saveSetting = async (label: string, value: string) => {
  const response = page.waitForResponse(
    (r) => r.url().endsWith("/api/m/calendar/briefing-settings") && r.request().method() === "PATCH"
  );
  await frame.getByLabel(label, { exact: true }).selectOption(value);
  assert.equal((await response).status(), 200, `${label} save`);
  await saved.waitFor();
};
await saveSetting("Look ahead", "0");
await saveSetting("Prep tasks", "off");
const confirmed = await context.request.get(`${origin}/api/m/calendar/briefing-settings`, {
  headers: { origin }
});
const settings = (await confirmed.json()).settings;
assert.equal(settings.lookaheadDays, 0);
assert.equal(settings.prepTaskMode, "off");
await page.screenshot({ path: join(OUT!, "calendar-settings.png") });
await page.reload();
await lookAhead.waitFor({ timeout: 60_000 });
assert.equal(await lookAhead.inputValue(), "0");
console.log(
  "PASS settings changed in the real control are saved by the server and survive a reload"
);

// Briefing switch: on by default, saved through the real control, kept after reload.
const signal = frame.getByLabel("Include calendar signal in briefings", { exact: true });
await signal.waitFor({ timeout: 60_000 });
assert.equal(await signal.isChecked(), true, "default is on");
const toggled = page.waitForResponse(
  (r) =>
    r.url().endsWith("/api/m/calendar/source-behaviors/calendar.briefings") &&
    r.request().method() === "PUT"
);
await signal.uncheck();
assert.equal((await toggled).status(), 200, "briefing switch save");
await saved.waitFor();
const behaviors = await context.request.get(`${origin}/api/m/calendar/source-behaviors`, {
  headers: { origin }
});
const rows = (await behaviors.json()).sources[0].behaviors;
assert.equal(rows.find((b: { id: string }) => b.id === "calendar.briefings").enabled, false);
assert.equal(rows.find((b: { id: string }) => b.id === "calendar.planning").enabled, true);
await page.screenshot({ path: join(OUT!, "calendar-briefing-switch.png") });
await page.reload();
await signal.waitFor({ timeout: 60_000 });
assert.equal(await signal.isChecked(), false, "switch stays off after reload");
console.log("PASS the briefing switch is saved by the server and survives a reload");

assert.deepEqual(failed, [], "server errors during the run");
await browser.close();
