/* global document */
// Browser pass for the Backtrack screen against the real server held up by the live gate.
// Usage: MOSS_BACKTRACK_HOLD=<dir> run the live gate, then
//   node modules/backtrack/tools/screen-live.mjs <url from <dir>/url.txt> <screenshot dir>
// Today and Choose a day were clicked by hand in the recorded pass; this script covers the rest.
// Seed storage and segments in the gate database first. Touch <dir>/finished to end the gate.
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const email = "backtrack-owner@example.test";
const password = "temporary-backtrack-password-235-not-a-real-secret";
const browser = await chromium.launch();

for (const [name, width] of [
  ["desktop", 1280],
  ["phone", 390]
]) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height: 800 }
  });
  const page = await context.newPage();
  await page.goto(`${url}/api/hello`);
  await page.evaluate(
    async ([e, p]) =>
      fetch("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: e, password: p })
      }),
    [email, password]
  );
  page.on("response", async (r) => {
    if (r.url().includes("/api/m/backtrack") && r.request().method() !== "GET") {
      console.log(
        `[${name}]`,
        r.request().method(),
        r.status(),
        (await r.text().catch(() => "")).slice(0, 100)
      );
    }
  });
  await page.goto(
    `${url}/module-frame?module=backtrack&path=${encodeURIComponent("/settings/backtrack")}`
  );
  await page.waitForTimeout(4000);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error(`${name}: the screen frame did not load`);
  const tail = async () =>
    (await frame.locator("body").innerText()).replace(/\n+/g, " | ").slice(-300);
  console.log(`[${name}] start`, await tail());
  await frame.locator("label.jds-switch").click();
  await page.waitForTimeout(1200);
  await frame.locator("label.jds-switch").click();
  await page.waitForTimeout(1200);
  await frame.getByRole("button", { name: "Last hour" }).click();
  console.log(`[${name}] confirm`, await tail());
  await page.screenshot({ path: `${out}/${name}-confirm.png`, fullPage: true });
  await frame.locator("#bt-cancel").click();
  await frame.getByRole("button", { name: "Everything…" }).click();
  await frame.locator("[role=alertdialog] button.jds-btn--danger").click();
  await page.waitForTimeout(2500);
  console.log(`[${name}] after delete all`, await tail());
  const wide = await page.evaluate(() => document.documentElement.scrollWidth);
  console.log(`[${name}] sideways scroll:`, wide > width);
  await context.close();
}
await browser.close();
