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
    } else {
      await expect(page.getByRole("table", { name: "Your meetings", exact: true })).toBeHidden();
      await rail.getByRole("button", { name: "Back to results", exact: true }).click();
      const row = page.getByRole("button", { name: title, exact: true });
      await expect(row).toBeFocused();
      await expect(rail).toBeHidden();
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
  const row = page.getByRole("button", { name: title, exact: true });
  await row.focus();
  await expect(row).toBeFocused();
  expect(await row.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
}
