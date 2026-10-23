import { expect, test, type Page } from "@playwright/test";
import { UAT_ADMIN_EMAIL, UAT_ADMIN_PASSWORD } from "../seed/admin.js";

export const uatLevel = {
  level: "admin+data",
  without: ["news", "sports", "tasks", "notes", "finance"]
} as const;

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email", { exact: true }).fill(UAT_ADMIN_EMAIL);
  await page.getByLabel("Password", { exact: true }).fill(UAT_ADMIN_PASSWORD);
  await page.locator("form.auth-form").getByRole("button", { name: "Sign in" }).click();
  const skip = page.getByRole("button", { name: "Skip", exact: true });
  await expect(
    skip
      .or(page.getByRole("button", { name: /^Account menu(?:,|$)/ }))
      .or(page.getByRole("button", { name: "Open navigation" }))
      .first()
  ).toBeVisible();
  if (await skip.isVisible()) {
    await skip.click();
    await page.getByRole("button", { name: "Skip anyway" }).click();
  }
}

async function todayVisible(page: Page, selector: string) {
  const today = page.locator(selector);
  await expect(today).toBeVisible();
  await expect
    .poll(() =>
      today.evaluate((cell) => {
        const region = cell.closest(".cal-body")!;
        const r = region.getBoundingClientRect();
        const c = cell.getBoundingClientRect();
        return (
          c.left >= r.left - 1 &&
          c.right <= r.right + 1 &&
          c.top >= r.top - 1 &&
          c.bottom <= r.bottom + 1
        );
      })
    )
    .toBe(true);
}

for (const width of [1280, 390, 320]) {
  test(`Week and Month focus today and Month fits at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await signIn(page);
    // Local today is Sep 24 in the saved Los Angeles zone, while UTC is Sep 25.
    await page.clock.setFixedTime(new Date("2026-09-25T00:30:00Z"));
    await page.evaluate(() => {
      localStorage.setItem("moss.cal.view", "week");
      localStorage.setItem("moss.cal.cursor", "2026-08-01T00:00:00Z");
    });
    await page.goto("/calendar");
    // Exercise the unchanged shared styles in light, dark and a park theme.
    await page.evaluate((w) => {
      document.documentElement.dataset.colorMode = w === 390 ? "dark" : "light";
      document.documentElement.dataset.theme = w === 320 ? "sage" : "default";
    }, width);
    const view = page.getByRole("group", { name: "View" });
    await todayVisible(page, ".cal-tg__dayhd.is-today");
    await expect(page.locator(".cal-tg__dayhd.is-today")).toContainText("24");
    await page.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(page.locator(".cal-tg__dayhd.is-today")).toHaveCount(0);
    await view.getByRole("button", { name: "Month", exact: true }).click();
    await todayVisible(page, ".cal-mcell.is-today");
    const month = page.getByRole("region", { name: "Calendar month" });
    expect(await month.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(
      true
    );
    await expect(page.locator("#calendar-scroll-hint")).toHaveCount(0);
    await expect(page.locator(".cal-month__dow")).toHaveCount(7);
    // Exercise compact cells with connector-backed events seeded through the real repository.
    for (let i = 0; i < 8; i++) {
      await page.getByRole("button", { name: "Previous", exact: true }).click();
    }
    await expect(page.locator(".cal-range")).toHaveText("January 2026");
    const event = page.getByRole("button", { name: /Team standup/ }).first();
    await expect(event).toBeVisible();
    expect(await month.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await event.click();
    await expect(page.getByRole("dialog", { name: "Event details" })).toContainText("Team standup");
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.getByRole("button", { name: "Today", exact: true }).click();
    // Explicit month navigation still works; reentry returns to today.
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(page.locator(".cal-range")).toHaveText("October 2026");
    await page.reload();
    await todayVisible(page, ".cal-mcell.is-today");
    await expect(page.locator(".cal-range")).toHaveText("September 2026");
    await view.getByRole("button", { name: "Week", exact: true }).click();
    await todayVisible(page, ".cal-tg__dayhd.is-today");
    // A manual sideways scroll can be recovered with Today even in the same week.
    await page.locator(".cal-body").evaluate((el) => {
      el.scrollLeft = 0;
    });
    await page.getByRole("button", { name: "Today", exact: true }).click();
    await todayVisible(page, ".cal-tg__dayhd.is-today");
    console.log(
      JSON.stringify({ width, weekTodayVisible: true, monthFits: true, monthReloadToday: true })
    );
  });
}
