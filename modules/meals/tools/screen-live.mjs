// Browser pass for the Meals screen against the real server held up by the live gate.
// Usage: MOSS_MEALS_HOLD=<dir> run the live gate, then
//   node modules/meals/tools/screen-live.mjs <url from <dir>/url.txt> <screenshot dir>
// Real data only. Nothing is intercepted or rewritten. Touch <dir>/finished to end the gate.
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const password = "temporary-meals-password-287-not-a-real-secret";
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed += 1;
};

async function open(width, email) {
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
    if (r.url().includes("/api/m/meals") && r.status() >= 400) {
      console.log(`[${width}] ${r.request().method()} ${r.status()} ${r.url().slice(-60)}`);
    }
  });
  await page.goto(`${url}/module-frame?module=meals&path=${encodeURIComponent("/meals")}`);
  await page.waitForTimeout(3500);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error(`${width}: the screen frame did not load`);
  return { context, page, frame };
}
const textOf = async (frame) => (await frame.locator("body").innerText()).replace(/\n+/g, " | ");
const tab = async (page, frame, name) => {
  await frame.getByRole("button", { name, exact: true }).first().click();
  await page.waitForTimeout(1800);
};

for (const [name, width] of [
  ["desktop", 1280],
  ["phone", 390]
]) {
  // The owner has a plan, a list and a Pantry.
  const { context, page, frame } = await open(width, "meals-owner@example.test");
  let body = await textOf(frame);
  check(`${name} plan shows the planned meal`, body.includes("Live"), body.slice(0, 300));
  check(`${name} plan has no load error`, !body.includes("Couldn't load"), body.slice(0, 300));
  await page.screenshot({ path: `${out}/${name}-plan.png`, fullPage: true });

  await frame.locator('[data-act="open-recipe"]').first().click();
  await page.waitForTimeout(2000);
  body = await textOf(frame);
  check(
    `${name} recipe opens with a way back`,
    body.includes("Back to the plan"),
    body.slice(0, 300)
  );
  await page.screenshot({ path: `${out}/${name}-recipe.png`, fullPage: true });
  await frame.locator('[data-act="back"]').first().click();
  await page.waitForTimeout(1800);

  await tab(page, frame, "Shopping list");
  body = await textOf(frame);
  check(
    `${name} list loads`,
    !body.includes("Couldn't load") && body.includes("Add item"),
    body.slice(0, 300)
  );
  await page.screenshot({ path: `${out}/${name}-list.png`, fullPage: true });

  await tab(page, frame, "Pantry");
  body = await textOf(frame);
  check(`${name} pantry shows what is on hand`, /milk/i.test(body), body.slice(0, 300));
  await page.screenshot({ path: `${out}/${name}-pantry.png`, fullPage: true });

  // Add, remove and undo a Pantry item through the real route.
  const item = `Browser rice ${name}`;
  await frame.getByRole("button", { name: "Add item" }).first().click();
  await page.waitForTimeout(600);
  await frame.locator("#f-name").fill(item);
  await frame.locator("#f-amount").fill("2");
  await frame.locator("#f-unit").fill("lb");
  await page.screenshot({ path: `${out}/${name}-pantry-add.png`, fullPage: true });
  await frame.locator(".jds-dialog").getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(1800);
  body = await textOf(frame);
  check(`${name} added item is listed`, body.includes(item), body.slice(0, 400));
  await frame.getByRole("button", { name: `Remove ${item}` }).click();
  await page.waitForTimeout(1800);
  body = await textOf(frame);
  check(
    `${name} removal shows Undo`,
    body.includes(`Removed ${item}`) && body.includes("Undo"),
    body.slice(0, 400)
  );
  await frame.getByRole("button", { name: "Undo" }).click();
  await page.waitForTimeout(2000);
  body = await textOf(frame);
  check(`${name} Undo brings the item back`, body.includes(item), body.slice(0, 400));
  await frame.getByRole("button", { name: `Remove ${item}` }).click();
  await page.waitForTimeout(1500);

  // Staples dialog.
  await frame.getByRole("button", { name: "Edit Staples" }).first().click();
  await page.waitForTimeout(600);
  await frame.locator("#f-staple").fill(`Salt ${name}`);
  await frame.locator("#f-staple").press("Enter");
  await page.waitForTimeout(1800);
  body = await textOf(frame);
  check(`${name} Staple is added`, body.includes(`Salt ${name}`), body.slice(0, 400));
  await page.screenshot({ path: `${out}/${name}-staples.png`, fullPage: true });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(`${name} Escape closes the dialog`, (await frame.locator(".jds-dialog").count()) === 0);
  await context.close();

  // The second person has nothing yet: empty week and empty Pantry.
  const other = await open(width, "meals-other@example.test");
  body = await textOf(other.frame);
  check(`${name} empty week offers a plan`, body.includes("Plan with Moss"), body.slice(0, 300));
  await other.page.screenshot({ path: `${out}/${name}-empty-plan.png`, fullPage: true });
  await tab(other.page, other.frame, "Pantry");
  body = await textOf(other.frame);
  check(`${name} empty Pantry says so`, body.includes("The Pantry is empty"), body.slice(0, 300));
  check(`${name} second person sees no milk`, !/milk/i.test(body));
  await other.page.screenshot({ path: `${out}/${name}-empty-pantry.png`, fullPage: true });
  await other.context.close();
}
await browser.close();
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
