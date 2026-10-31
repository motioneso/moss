import { expect } from "vitest";
import type { Locator, Page } from "playwright-core";
/** Follow the rendered server backoff with one explicit saved-state read; never retry a write. */
export async function waitForFinanceAction(
  page: Page,
  action: Locator,
  refreshLabel = "Check saved records"
) {
  const enabled = action.and(page.locator(":enabled"));
  const busy = page
    .getByRole("alert")
    .or(page.getByRole("status"))
    .filter({ hasText: /Finance is temporarily busy/ });
  await enabled.or(busy).first().waitFor();
  if (await busy.isVisible()) {
    const seconds = Number((await busy.innerText()).match(/Wait (\d+) seconds?/)?.[1]);
    expect(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
    await page.waitForTimeout(Math.min(seconds * 1000 + 100, 60000));
    await page.getByRole("button", { name: refreshLabel, exact: true }).click();
  }
  await enabled.waitFor();
}
