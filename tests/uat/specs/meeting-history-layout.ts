import { expect, type Page } from "@playwright/test";
import { assertMeetingTextContrast } from "./meeting-review-layout.js";

/** Executable real-DOM checks only; no screenshot or network substitution. */
export async function assertMeetingHistoryLayout(page: Page, title: string): Promise<void> {
  const rail = page.getByRole("complementary", { name: "Selected meeting", exact: true });
  for (const width of [1600, 1180, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(rail).toBeVisible();
    if (width > 1080) {
      const positions = await page.evaluate(() => ({
        table: document.querySelector(".meetings-history-results")!.getBoundingClientRect().right,
        rail: document.querySelector(".meetings-history-rail")!.getBoundingClientRect().left
      }));
      expect(positions.rail).toBeGreaterThan(positions.table);
      await assertHistorySectionSpacing(page);
    } else {
      await expect(page.getByRole("table", { name: "Your meetings", exact: true })).toBeHidden();
      await rail.getByRole("button", { name: "Back to results", exact: true }).click();
      const row = page.getByRole("button", { name: title, exact: true });
      await expect(row).toBeFocused();
      await expect(rail).toBeHidden();
      await assertHistorySectionSpacing(page);
      await row.press("Enter");
      await expect(rail).toBeVisible();
      await expect
        .poll(() => rail.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
      await page.goBack();
      await expect(rail).toBeHidden();
      await expect(row).toBeFocused();
      await page.goForward();
      await expect(rail).toBeVisible();
      await expect
        .poll(() => rail.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true);
    }
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBe(0);
    const minimum = await rail
      .locator(".jds-index__title, .jds-index__meta, .jds-hint")
      .evaluateAll((elements) =>
        Math.min(...elements.map((element) => parseFloat(getComputedStyle(element).fontSize)))
      );
    expect(minimum).toBeGreaterThanOrEqual(11);
  }
  await assertMeetingTextContrast(page, rail.locator(".jds-index__title").first());
  await assertMeetingTextContrast(page, rail.locator(".jds-index__meta").first());
  await assertMeetingTextContrast(page, rail.locator(".jds-hint").first());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertMeetingHistoryKeyboardFocus(page, title);
}

async function assertHistorySectionSpacing(page: Page): Promise<void> {
  const spacing = await page
    .getByRole("table", { name: "Your meetings", exact: true })
    .evaluate((table) => {
      const section = table
        .closest(".meetings-history-results")!
        .querySelector(".meetings-history-followup")!;
      const minimum = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--space-7")
      );
      return {
        gap: section.getBoundingClientRect().top - table.getBoundingClientRect().bottom,
        minimum
      };
    });
  expect(spacing.gap).toBeGreaterThanOrEqual(spacing.minimum - 1);
}

export async function assertMeetingHistoryKeyboardFocus(page: Page, title: string): Promise<void> {
  const row = page.getByRole("button", { name: title, exact: true });
  // The State filter immediately precedes the first result. Enter the result with real
  // keyboard navigation; programmatic focus after pointer use has different modality.
  await page.getByLabel("State", { exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  expect(await row.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  // Shared Button deliberately uses a 3px shadow ring with outline:none.
  await expect(row).toHaveCSS("box-shadow", /0px 0px 0px 3px$/);
  await expect(row).not.toHaveCSS("box-shadow", /^rgba\([^)]*,\s*0\) /);
}
