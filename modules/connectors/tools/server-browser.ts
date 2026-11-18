/**
 * Real-browser check of the Connections screen on the real Rust server over HTTPS.
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
  `${origin}/module-frame?module=connectors&path=${encodeURIComponent("/settings/connections")}`
);
const frame = page.frameLocator("#frame");
// The account made by the server test is revoked, so the screen shows it as such.
await frame.getByText("Google", { exact: false }).first().waitFor({ timeout: 60_000 });
await page.screenshot({ path: join(OUT!, "connections.png") });
const text = await frame.locator("body").innerText();
for (const marker of ["SENTINEL-PASSWORD", "SENTINEL-ACCESS", "SENTINEL-REFRESH"]) {
  assert.ok(!text.includes(marker), `screen shows ${marker}`);
}
console.log(
  "PASS Connections screen opens on the real server and shows the owner's account without any secret"
);

// Connect Google through the screen, with the fake Google behind the server.
const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CODE } = process.env;
for (const [name, value] of Object.entries({
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_CODE
})) {
  if (!value) throw new Error(`Set ${name}`);
}
await frame.getByRole("button", { name: "Connect Google" }).click();
await frame.getByLabel("Client ID").fill(GOOGLE_CLIENT_ID!);
await frame.getByLabel("Client secret").fill(GOOGLE_CLIENT_SECRET!);
await page.screenshot({ path: join(OUT!, "google-credentials.png") });
await frame.getByRole("button", { name: "Open consent screen" }).click();
const address = frame.locator("#google-consent");
await address.waitFor({ timeout: 30_000 });
const consent = new URL(await address.inputValue());
assert.equal(consent.hostname, "accounts.google.com");
const state = consent.searchParams.get("state");
assert.ok(state, "consent address carries a state");
const finish = frame.getByRole("button", { name: "Finish connection" });
assert.equal(await finish.isDisabled(), true, "finish waits for a valid pasted address");
await frame.getByLabel("Address Google sent you to").fill("http://example.com/?code=nope");
assert.equal(await finish.isDisabled(), true, "a non-localhost address is refused locally");
await frame
  .getByLabel("Address Google sent you to")
  .fill(`http://localhost:1/?code=${GOOGLE_CODE}&state=${state}`);
await page.screenshot({ path: join(OUT!, "google-finish.png") });
await finish.click();
await frame.getByText("Connected Google").waitFor({ timeout: 30_000 });
await page.screenshot({ path: join(OUT!, "google-connected.png") });
const after = await frame.locator("body").innerText();
for (const secret of [GOOGLE_CLIENT_SECRET!, "ya29.fake-access-", "1//fake-refresh-"]) {
  assert.ok(!after.includes(secret), `screen shows ${secret}`);
}
console.log(
  "PASS Google connect through the screen: fields, consent address, paste, finish, success"
);
assert.deepEqual(failed, [], `server errors: ${failed.join(", ")}`);
await browser.close();
