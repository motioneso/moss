/* global document */
// Browser pass for the Meetings screen against the real server held up by the live gate.
// Usage: MOSS_MEETINGS_HOLD=<dir> run the live gate, then
//   node modules/meetings/tools/screen-live.mjs <url from <dir>/url.txt> <screenshot dir>
// Real data only. Nothing is intercepted or rewritten. Touch <dir>/finished to end the gate.
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
  await page.goto(`${url}/module-frame?module=meetings&path=${encodeURIComponent("/meetings")}`);
  await page.waitForTimeout(3500);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error(`${name}: the screen frame did not load`);
  const text = async () => (await frame.locator("body").innerText()).replace(/\n+/g, " | ");

  // Home.
  let body = await text();
  check(`${name} home lists the seeded meeting`, body.includes("Renamed"), body.slice(0, 300));
  check(`${name} home has Add recording`, body.includes("Add recording"));
  await page.screenshot({ path: `${out}/${name}-home.png`, fullPage: true });

  // Search by a word in the transcript.
  await frame.locator("#meeting-history-search").fill("zzzznothing");
  await page.waitForTimeout(1500);
  body = await text();
  check(
    `${name} empty search says so`,
    body.includes("No meetings match this search."),
    body.slice(0, 300)
  );
  await frame.locator("#meeting-history-search").fill("");
  await page.waitForTimeout(1500);

  // Open the meeting with keyboard: focus the title button and press Enter.
  await frame.getByRole("button", { name: "Renamed" }).first().focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(2500);
  body = await text();
  check(
    `${name} meeting page opens by keyboard`,
    body.includes("Renamed") && body.includes("Notes"),
    body.slice(0, 300)
  );
  const notes = await frame.locator("#meeting-personal-notes").inputValue();
  check(`${name} saved notes show`, notes.includes("agenda"), notes);
  await frame.locator("#meeting-personal-notes").fill(`${notes}\nbrowser edit ${name}`);
  await page.waitForTimeout(2500);
  body = await text();
  check(`${name} notes autosave`, body.includes("Saved"), body.slice(-200));
  await page.screenshot({ path: `${out}/${name}-record.png`, fullPage: true });

  // Tabs by keyboard on a narrow screen.
  const tab = frame.getByRole("tab", { name: /Transcript/ });
  if (await tab.count()) {
    await tab.first().click();
    await page.waitForTimeout(1200);
    body = await text();
    check(`${name} transcript shows the spoken line`, body.includes("spoken"), body.slice(0, 300));
    await page.screenshot({ path: `${out}/${name}-transcript.png`, fullPage: true });
  }

  // Add recording.
  await frame
    .getByRole("button", { name: "Meetings" })
    .first()
    .click()
    .catch(() => {});
  await page.goto(`${url}/module-frame?module=meetings&path=${encodeURIComponent("/meetings")}`);
  await page.waitForTimeout(2500);
  await frame
    .getByRole("button", { name: "Add recording" })
    .first()
    .click()
    .catch(async () => {
      await page
        .frames()
        .find((f) => f !== page.mainFrame())
        .getByRole("button", { name: "Add recording" })
        .first()
        .click();
    });
  await page.waitForTimeout(800);
  const f2 = page.frames().find((f) => f !== page.mainFrame());
  await f2
    .locator("#recording-transcript")
    .fill(`Browser ${name} pasted: we agreed to ship on Friday.`);
  await page.screenshot({ path: `${out}/${name}-manual.png`, fullPage: true });
  await f2.getByRole("button", { name: "Add recording" }).last().click();
  await page.waitForTimeout(3000);
  body = (await f2.locator("body").innerText()).replace(/\n+/g, " | ");
  check(
    `${name} pasted transcript becomes a meeting`,
    body.includes("Notes") || body.includes("Summary"),
    body.slice(0, 300)
  );
  await page.screenshot({ path: `${out}/${name}-after-manual.png`, fullPage: true });
  await context.close();
}
await browser.close();
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
