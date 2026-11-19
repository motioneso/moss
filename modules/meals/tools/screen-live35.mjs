// Browser pass for Meals part 35 (Household, Log, settings, plan helper screens).
// Usage: MOSS_MEALS_HOLD=<dir> run the live gate, then
//   node modules/meals/tools/screen-live35.mjs <url from <dir>/url.txt> <screenshot dir>
// Real data only. Nothing is intercepted or rewritten.
import { chromium } from "playwright-core";

const [url, out] = process.argv.slice(2);
const password = "temporary-meals-password-287-not-a-real-secret";
const browser = await chromium.launch();
let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(ok ? "PASS" : "FAIL", name, ok ? "" : detail);
  if (!ok) failed += 1;
};

async function open(width, email, path = "/meals") {
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
  await page.goto(`${url}/module-frame?module=meals&path=${encodeURIComponent(path)}`);
  await page.waitForTimeout(3500);
  const frame = page.frames().find((f) => f !== page.mainFrame());
  if (!frame) throw new Error(`${width}: the screen frame did not load`);
  return { context, page, frame };
}
const textOf = async (frame) => (await frame.locator("body").innerText()).replace(/\n+/g, " | ");
const wait = (page, ms = 1800) => page.waitForTimeout(ms);
const tab = async (page, frame, name) => {
  await frame.getByRole("button", { name, exact: true }).first().click();
  await wait(page);
};
const clickAct = async (page, frame, act, nth = 0) => {
  const el = frame.locator(`[data-act="${act}"]`).nth(nth);
  try {
    await el.click({ timeout: 5000 });
  } catch {
    // A dialog button can sit below the visible part of a tall frame on a phone.
    console.log(`NOTE ${act} was below the fold, clicked directly`);
    await el.evaluate((node) => node.click());
  }
  await wait(page);
};
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.png`, fullPage: true });

for (const [name, width] of [
  ["phone", 390],
  ["desktop", 1280]
]) {
  const { context, page, frame } = await open(width, "meals-owner@example.test");
  let body;

  // Five tabs fit.
  const tabsWide = await frame
    .locator(".mls-tabs")
    .evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  check(`${name} five tabs fit without sideways scroll`, tabsWide);

  // Household.
  await tab(page, frame, "Household");
  body = await textOf(frame);
  check(
    `${name} household loads`,
    body.includes("Add person") && !body.includes("Couldn't load"),
    body.slice(0, 300)
  );
  await shot(page, `${name}-household`);
  const person = `Sam ${name}`;
  await clickAct(page, frame, "add-person");
  await frame.locator("#p-name").fill(person);
  await frame.locator("#p-never").fill("peanuts, shellfish");
  await frame.locator("#p-likes").fill("pasta");
  await frame.locator("#p-calories").fill("2000");
  await shot(page, `${name}-household-add`);
  await clickAct(page, frame, "save-person");
  body = await textOf(frame);
  check(
    `${name} added person is listed`,
    body.includes(person) && body.includes("peanuts"),
    body.slice(0, 500)
  );
  check(
    `${name} sharing section appears with two people`,
    body.includes("Who eats together"),
    body.slice(0, 500)
  );
  await shot(page, `${name}-household-two`);
  await frame.getByRole("button", { name: `Edit ${person}` }).click();
  await wait(page, 700);
  await frame.locator("#p-likes").fill("pasta, soup");
  await clickAct(page, frame, "save-person");
  body = await textOf(frame);
  check(`${name} edited person shows the new like`, body.includes("soup"), body.slice(0, 500));
  // Empty name is refused.
  await frame.getByRole("button", { name: `Edit ${person}` }).click();
  await wait(page, 700);
  await frame.locator("#p-name").fill("");
  await clickAct(page, frame, "save-person", 0);
  check(`${name} empty name is refused`, (await frame.locator(".jds-dialog").count()) === 1);
  await shot(page, `${name}-household-invalid`);
  await page.keyboard.press("Escape");
  await wait(page, 600);
  check(
    `${name} Escape closes the person dialog`,
    (await frame.locator(".jds-dialog").count()) === 0
  );
  await frame.getByRole("button", { name: `Remove ${person}` }).click();
  await wait(page, 700);
  await shot(page, `${name}-household-remove`);
  await clickAct(page, frame, "confirm-remove");
  body = await textOf(frame);
  check(`${name} removed person is gone`, !body.includes(person), body.slice(0, 500));

  // Log.
  await tab(page, frame, "Log");
  body = await textOf(frame);
  check(
    `${name} log loads`,
    body.includes("Log a meal") && !body.includes("Couldn't load"),
    body.slice(0, 300)
  );
  await shot(page, `${name}-log-empty`);
  const meal = `two eggs and toast ${name}`;
  await frame.getByRole("button", { name: "Log a meal" }).first().click();
  await wait(page, 700);
  await frame.locator("#a-desc").fill(meal);
  await shot(page, `${name}-log-add`);
  await clickAct(page, frame, "save-add");
  body = await textOf(frame);
  check(`${name} logged meal is listed`, body.includes(meal), body.slice(0, 500));
  await shot(page, `${name}-log-entry`);
  await frame.getByRole("button", { name: `Edit ${meal}` }).click();
  await wait(page, 700);
  await frame.locator("#e-desc").fill(`${meal} edited`);
  await clickAct(page, frame, "save-edit");
  body = await textOf(frame);
  check(
    `${name} edited entry shows new words`,
    body.includes(`${meal} edited`),
    body.slice(0, 500)
  );
  await frame.getByRole("button", { name: "Previous day" }).click();
  await wait(page);
  body = await textOf(frame);
  check(`${name} previous day is empty`, body.includes("Nothing logged"), body.slice(0, 400));
  await shot(page, `${name}-log-prev-day`);
  await frame.getByRole("button", { name: "Next day" }).click();
  await wait(page);
  await frame.getByRole("button", { name: `Delete ${meal} edited` }).click();
  await wait(page, 700);
  await shot(page, `${name}-log-delete`);
  await clickAct(page, frame, "confirm-delete");
  body = await textOf(frame);
  check(`${name} deleted entry is gone`, !body.includes(`${meal} edited`), body.slice(0, 500));

  // Plan helpers.
  await tab(page, frame, "Plan");
  body = await textOf(frame);
  for (const label of ["Swap", "Move", "Eaters", "Text", "New plan"]) {
    check(`${name} plan offers ${label}`, body.includes(label), body.slice(0, 300));
  }
  await shot(page, `${name}-plan-tools`);
  await clickAct(page, frame, "move");
  body = await textOf(frame);
  check(`${name} move screen opens`, body.includes("Back to the plan"), body.slice(0, 400));
  await shot(page, `${name}-move`);
  await clickAct(page, frame, "back");
  await clickAct(page, frame, "eaters");
  body = await textOf(frame);
  check(`${name} eaters screen opens`, body.includes("Back to the plan"), body.slice(0, 400));
  await shot(page, `${name}-eaters`);
  await clickAct(page, frame, "back");
  await clickAct(page, frame, "swap");
  body = await textOf(frame);
  check(
    `${name} swap screen opens with choices`,
    body.includes("Back to the plan") && /Choose|Find|Writing/.test(body),
    body.slice(0, 500)
  );
  await shot(page, `${name}-swap`);
  await clickAct(page, frame, "back");

  // Saving text replaces the planned recipe, so only the desktop pass saves it. The phone pass
  // opens the screen and types, then goes back.
  await clickAct(page, frame, "text");
  await frame.locator("#t-text").fill("Leftovers night");
  const saveOn = await frame.locator('[data-act="save-text"]').isEnabled();
  check(`${name} typing enables Save text`, saveOn);
  await shot(page, `${name}-text`);
  if (name === "desktop") {
    await clickAct(page, frame, "save-text");
    body = await textOf(frame);
    check(`${name} text replaces the meal`, body.includes("Leftovers night"), body.slice(0, 500));
    check(`${name} text-only meal still offers Text`, body.includes("Text"));
  } else await clickAct(page, frame, "back");

  // Settings page, opened as the header cog does.
  const s = await open(width, "meals-owner@example.test", "/settings/meals");
  body = await textOf(s.frame);
  check(
    `${name} settings loads`,
    body.includes("Units") && body.includes("Pantry mode for new plans"),
    body.slice(0, 400)
  );
  await shot(s.page, `${name}-settings`);
  await s.frame.getByRole("button", { name: "Metric", exact: true }).click();
  await wait(s.page, 2200);
  const pressed = await s.frame
    .getByRole("button", { name: "Metric", exact: true })
    .getAttribute("aria-pressed");
  check(`${name} Metric is saved and shown`, pressed === "true");
  await s.frame.getByRole("button", { name: "US", exact: true }).click();
  await wait(s.page, 2200);
  await s.frame.getByText("Only what's on hand").click();
  await wait(s.page, 2200);
  const only = await s.frame.locator('input[value="only"]').isChecked();
  check(`${name} pantry mode is saved and shown`, only);
  await shot(s.page, `${name}-settings-saved`);
  await s.frame.getByText("Ignore the Pantry").click();
  await wait(s.page, 2000);
  await s.context.close();

  // New plan.
  await tab(page, frame, "Plan");
  await clickAct(page, frame, "new-plan");
  body = await textOf(frame);
  check(`${name} new plan form opens`, body.includes("Start the plan"), body.slice(0, 500));
  await shot(page, `${name}-new-plan`);
  await context.close();

  // Second person: empty states.
  const other = await open(width, "meals-other@example.test");
  body = await textOf(other.frame);
  check(
    `${name} empty week offers Start a plan`,
    body.includes("Start a plan"),
    body.slice(0, 300)
  );
  await shot(other.page, `${name}-empty-plan`);
  await tab(other.page, other.frame, "Log");
  body = await textOf(other.frame);
  check(
    `${name} second person log says nothing logged`,
    body.includes("Nothing logged"),
    body.slice(0, 300)
  );
  await shot(other.page, `${name}-empty-log`);
  await tab(other.page, other.frame, "Household");
  body = await textOf(other.frame);
  check(
    `${name} second person household is only themselves`,
    !body.includes("Sam"),
    body.slice(0, 300)
  );
  await other.context.close();
}
await browser.close();
console.log(failed ? `${failed} checks failed` : "all checks passed");
process.exit(failed ? 1 : 0);
