import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseTransactionDetails(
  page: Page,
  name: string,
  month: string,
  read: Read,
  artifacts?: string
) {
  const before = await read("finance.transactions.query", { month, ownOnly: true });
  const row = (before.transactions as Record<string, unknown>[]).find((r) => r.name === name)!;
  expect(row.notes).toBe("Synthetic private context");
  const open = () =>
    page
      .getByRole("button", { name: `View transaction details for ${name}`, exact: true })
      .filter({ visible: true });
  await open().click();
  const dialog = page.getByRole("dialog", { name: "Transaction details", exact: true });
  expect(
    await dialog
      .getByRole("textbox", { name: "Private transaction note", exact: true })
      .inputValue()
  ).toBe(row.notes);
  expect(await dialog.getByRole("textbox").getAttribute("readonly")).not.toBeNull();
  await dialog.getByText("Money out · $12.34", { exact: true }).waitFor();
  await dialog.getByText("Synthetic metadata checking", { exact: true }).waitFor();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-transaction-details-${theme}-${width}.png`)
        });
    }
  }
  await dialog.getByRole("button", { name: "Back to register", exact: true }).click();
  await expect.poll(() => open().evaluate((e) => document.activeElement === e)).toBe(true);
  expect(await read("finance.transactions.query", { month, ownOnly: true })).toEqual(before);
}

export async function exerciseSharedTransactionDetails(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Transaction details", exact: true });
  const shared = page
    .getByRole("button", {
      name: "View transaction details for Synthetic household groceries",
      exact: true
    })
    .filter({ visible: true });
  await shared.click();
  await dialog.getByText("Household · read only", { exact: true }).waitFor();
  await dialog.getByText("Private notes are not shared.", { exact: true }).waitFor();
  expect(await dialog.getByRole("textbox").count()).toBe(0);
  expect(
    await dialog.getByText("Synthetic malformed-mirror private note", { exact: true }).count()
  ).toBe(0);
  await dialog.getByRole("button", { name: "Back to register", exact: true }).click();
  await expect.poll(() => shared.evaluate((e) => document.activeElement === e)).toBe(true);
}
