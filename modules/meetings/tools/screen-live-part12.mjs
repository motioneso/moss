// Browser pass for Meetings part 12 (settings, home Mac states, recording panel) against the real
// server held up by the live gate. Usage:
//   node modules/meetings/tools/screen-live-part12.mjs <url from <dir>/url.txt> <screenshot dir>
// Real data only. Nothing is intercepted or rewritten.
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const email = "meetings-owner@example.test";
const password = "temporary-meetings-password-235-not-a-real-secret";
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed += 1;
};

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
  page.on("response", (r) => {
    if (r.url().includes("/api/m/meetings") && r.status() >= 400) {
      console.log(`[${name}] ${r.request().method()} ${r.status()} ${r.url().slice(-60)}`);
    }
  });
  const open = async (path) => {
    await page.goto(`${url}/module-frame?module=meetings&path=${encodeURIComponent(path)}`);
    await page.waitForTimeout(3500);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (!frame) throw new Error(`${name}: the screen frame did not load for ${path}`);
    return frame;
  };
  const text = async (f) => (await f.locator("body").innerText()).replace(/\n+/g, " | ");

  // Home: the live server has no device pairing, so every Mac check is refused.
  let frame = await open("/meetings");
  let body = await text(frame);
  check(
    `${name} home says Mac access could not be verified`,
    body.includes("Mac access could not be verified"),
    body.slice(0, 300)
  );
  await page.screenshot({ path: `${out}/${name}-home.png` });

  // Settings.
  frame = await open("/settings/meetings");
  body = await text(frame);
  check(`${name} settings shows audio source`, body.includes("Audio source"), body.slice(0, 300));
  check(`${name} settings shows language`, body.includes("Transcript language"));
  check(
    `${name} settings shows the summary switch`,
    body.includes("Summarize automatically after Stop")
  );
  await page.screenshot({ path: `${out}/${name}-settings.png`, fullPage: true });
  await frame.locator("#meeting-settings-language").selectOption("en");
  await page.waitForTimeout(1500);
  await frame.locator("#meeting-settings-vocabulary").fill("Moss\nTrail Marker");
  await frame.getByRole("button", { name: "Save vocabulary" }).click();
  await page.waitForTimeout(2000);
  body = await text(frame);
  check(`${name} vocabulary saves`, body.includes("Vocabulary saved."), body.slice(0, 400));
  const before = await frame.locator("#meeting-settings-summarize").isChecked();
  await frame.locator(".jds-switch__track").click();
  await page.waitForTimeout(2500);
  frame = await open("/settings/meetings");
  const off = (await frame.locator("#meeting-settings-summarize").isChecked()) !== before;
  const kept = await frame.locator("#meeting-settings-vocabulary").inputValue();
  check(
    `${name} settings survive a reload`,
    off && kept.includes("Trail Marker"),
    `${off} ${kept}`
  );
  await frame.locator(".jds-switch__track").click();
  await page.waitForTimeout(1200);
  await frame.getByRole("button", { name: "Clear vocabulary" }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/${name}-settings-after.png`, fullPage: true });

  // Recording panel on an open meeting.
  frame = await open("/meetings");
  await frame
    .locator("button[data-open], .meetings-row button, table button")
    .first()
    .click()
    .catch(() => {});
  await page.waitForTimeout(2500);
  body = await text(frame);
  check(
    `${name} meeting page shows the recording panel`,
    /Ready|Connect|record/i.test(body),
    body.slice(0, 400)
  );
  await page.screenshot({ path: `${out}/${name}-record.png`, fullPage: true });
  await context.close();
}
await browser.close();
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
