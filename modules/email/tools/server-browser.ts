/**
 * Real-browser check of the Email settings screen on the real Rust server over HTTPS.
 * Started by the live gate with ORIGIN, EMAIL, PASSWORD and OUT set. Nothing is intercepted.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { chromium } from "@playwright/test";

const { ORIGIN, EMAIL, PASSWORD, OUT } = process.env;
for (const [name, value] of Object.entries({ ORIGIN, EMAIL, PASSWORD, OUT })) {
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
const signIn = await context.request.post(`${origin}/api/auth/sign-in/email`, {
  headers: { origin },
  data: { email: EMAIL, password: PASSWORD }
});
assert.equal(signIn.status(), 200, "sign-in");

await page.goto(
  `${origin}/module-frame?module=email&path=${encodeURIComponent("/settings/email")}`
);
const frame = page.frameLocator("#frame");
const open = async () => {
  await page.goto(
    `${origin}/module-frame?module=email&path=${encodeURIComponent("/settings/email")}`
  );
  await frame.getByText("Include important email in briefings").waitFor({ timeout: 60_000 });
};
const checked = (label: string) => frame.getByLabel(label).isChecked();
await open();
// The server test left these saved choices; the screen must show them as they are stored.
assert.equal(await frame.locator("#email-task-mode").inputValue(), "auto_safe");
assert.equal(await checked("Include important email in briefings"), false);
assert.equal(await checked("Suggest sending replies"), true);
assert.equal(await checked("Draft replies"), false);
assert.equal(await checked("Let your assistant draft email replies without asking"), true);
assert.equal(await checked("Suggest replies"), true);
await page.screenshot({ path: join(OUT!, "email-settings.png") });
// A real click saves through the module, and a fresh load shows the saved choice.
await frame.getByLabel("Suggest replies").uncheck();
await frame.locator("#email-task-mode").selectOption("off");
await page.waitForTimeout(1500);
await open();
assert.equal(await checked("Suggest replies"), false);
assert.equal(await frame.locator("#email-task-mode").inputValue(), "off");
await page.screenshot({ path: join(OUT!, "email-settings-after-change.png") });
const text = await frame.locator("body").innerText();
for (const marker of ["SENTINEL-BODY", "sentinel-address"]) {
  assert.ok(!text.includes(marker), `screen shows ${marker}`);
}
console.log(
  "PASS Email settings screen opens on the real server, shows the saved choices, saves a click and a menu change, and shows no message content"
);
assert.deepEqual(failed, [], `server errors: ${failed.join(", ")}`);
await browser.close();
