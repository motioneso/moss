import { expect, test } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = { level: "admin+data", without: [] } as const;

// #1497 / #1427-A: three Today CSS files (kit-today.css, kit-today-feeds.css,
// kit-today-misc.css) had their color/font/background/border-radius/shadow declarations moved
// out to packages/ui/src/styles/components-moss-today.css, leaving only layout rules behind in
// the app files. This is a pure move, not a value change — but if the package file were ever
// missing from the build, or loaded in the wrong order, the moved-out visuals would silently
// fall back to browser defaults (transparent background, 0 border-radius) with no type error and
// no failing unit test, since the app file's CSS would still parse fine on its own.
//
// The "nothing left on the calendar" line (.agenda-clear) is the default state of the "Today's
// agenda" rail card at this seed level -- it shows whenever there's no upcoming event left today,
// which is how admin+data seeds. Its text color is exactly the property task 3 moved into the
// package file, so reading it back with a real computed style proves the moved rule is actually
// applying, not just that the page loaded.
test("agenda-clear message keeps its real (non-default) text color after the CSS move", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  // Two elements share this class: a transient "Gathering your morning briefing…" loading
  // placeholder and the real "Nothing left on the calendar today" message. Match the real one by
  // its stable text so a slow-to-clear loading state can't make this pick the wrong node.
  const message = page.getByText("Nothing left on the calendar today");
  await expect(message).toBeVisible();

  const style = await message.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { color: computed.color, fontSize: computed.fontSize };
  });

  // A rule that never applied (or applied then vanished) reads back as the browser's default
  // black text at the parent's inherited size -- not the muted color/13px kit-today-misc.css
  // used to set inline before the move.
  expect(style.color).not.toBe("rgb(0, 0, 0)");
  expect(style.fontSize).toBe("13px");
});

// #1497 task 3: kit-today-misc.css moved the wellness meds/check-in button styling (background,
// color, border-radius) the same way. The wellness rail only renders when the account has the
// wellness module enabled, so this test skips rather than fails when it's off -- that's an
// account-configuration state, not a CSS regression this PR could cause.
test("wellness action buttons keep their real background and rounded corners after the CSS move", async ({
  page
}) => {
  const baseURL = process.env.JARVIS_UAT_BASE_URL;
  if (!baseURL) {
    throw new Error("JARVIS_UAT_BASE_URL must be set by run-uat.ts");
  }

  await page.goto(baseURL);
  await page.getByLabel("Email").fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password").fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();

  const wellCard = page.locator(".well");
  const wellCount = await wellCard.count();
  test.skip(wellCount === 0, "wellness module not enabled for this seed account");

  const medsButton = page.locator(".well__btn--meds");
  await expect(medsButton).toBeVisible();

  const style = await medsButton.evaluate((node) => {
    const computed = getComputedStyle(node);
    return { backgroundColor: computed.backgroundColor, borderRadius: computed.borderRadius };
  });

  expect(style.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(style.backgroundColor).not.toBe("transparent");
  expect(style.borderRadius).not.toBe("0px");
});
