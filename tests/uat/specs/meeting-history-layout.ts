import { expect, type Page } from "@playwright/test";
import { assertMeetingTextContrast } from "./meeting-review-layout.js";
import { meetingRow } from "./meeting-minimal-ui.js";

/** Executable real-DOM checks only; no screenshot or network substitution. */
export async function assertMeetingHistoryLayout(page: Page, title: string): Promise<void> {
  const row = meetingRow(page, title);
  for (const width of [1600, 1440, 1180, 390, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(row).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Selected meeting", exact: true })
    ).toHaveCount(0);
    const geometry = await row.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const list = element.closest('[aria-label="Your meetings"]')!.getBoundingClientRect();
      const text = [...element.querySelectorAll(".jds-label, .jds-hint")];
      return {
        width: bounds.width,
        listWidth: list.width,
        minimumFont: Math.min(...text.map((item) => parseFloat(getComputedStyle(item).fontSize)))
      };
    });
    expect(geometry.width).toBeGreaterThanOrEqual(geometry.listWidth - 2);
    expect(geometry.minimumFont).toBeGreaterThanOrEqual(11);
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        )
      )
      .toBe(0);
  }
  await assertMeetingTextContrast(page, row.locator(".jds-label"));
  await assertMeetingTextContrast(page, row.locator(".jds-hint").first());
  await page.setViewportSize({ width: 1440, height: 1000 });
  await assertMeetingHistoryKeyboardFocus(page, title);
}

export async function assertMeetingHistoryKeyboardFocus(page: Page, title: string): Promise<void> {
  const row = meetingRow(page, title);
  await page.getByRole("searchbox", { name: "Search meetings", exact: true }).focus();
  await page.keyboard.press("Tab");
  await expect(row).toBeFocused();
  expect(await row.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
  await expect(row).toHaveCSS("box-shadow", /0px 0px 0px 3px$/);
  await expect(row).not.toHaveCSS("box-shadow", /^rgba\([^)]*,\s*0\) /);
}
