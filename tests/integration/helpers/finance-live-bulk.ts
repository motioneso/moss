import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page, BrowserContext } from "playwright-core";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Row = {
  id: string;
  name: string;
  categoryId: string | null;
  writeRevision: string;
  [key: string]: unknown;
};
export async function exerciseBulkCategory(
  page: Page,
  context: BrowserContext,
  base: string,
  month: string,
  read: Read,
  artifacts?: string
) {
  const names = ["Synthetic, market", "Synthetic refund"];
  const rows = async () =>
    (
      (await read("finance.transactions.query", { month, limit: 2000 })).transactions as Row[]
    ).filter((r) => names.includes(r.name));
  const original = await rows();
  expect(original).toHaveLength(2);
  await page.goto(`${base}/m/finance/transactions`);
  const selected = (name: string) =>
    page.getByRole("checkbox", { name: `Select ${name}`, exact: true }).filter({ visible: true });
  await selected(names[0]!).focus();
  await selected(names[0]!).press("Space");
  await selected(names[1]!).check();
  await page.getByText("2 selected", { exact: true }).waitFor();
  await page
    .getByLabel("Category for selected transactions", { exact: true })
    .selectOption("groceries");
  await page
    .getByLabel("Search payees or notes", { exact: true })
    .fill("nothing-matches-synthetic");
  await page.getByText("No matches", { exact: true }).waitFor();
  await page.getByText("2 selected", { exact: true }).waitFor();
  await page.getByLabel("Search payees or notes", { exact: true }).fill("");
  await selected(names[0]!).waitFor();
  await page.getByRole("button", { name: "Review category change", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review selected transactions", exact: true });
  await review.getByText(names[0]!, { exact: true }).waitFor();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await review.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const footer = await review.locator(".jds-dialog__foot").boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-bulk-review-${theme}-${width}.png`),
          fullPage: false
        });
    }
  }
  const confirm = () =>
    review.getByRole("button", { name: "Confirm category change", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await confirm();
  await guard.waitFor();
  expect(await rows()).toEqual(original);
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await review
    .getByText("Cancelled. Your selection and category are kept.", { exact: true })
    .waitFor();
  await confirm();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.waitFor({ state: "detached" });
  const strip = (r: Row) => {
    const { writeRevision: _revision, ...rest } = r;
    return rest;
  };
  expect((await rows()).map(strip)).toEqual(
    original.map((r) => ({
      ...strip(r),
      categoryId: "groceries",
      categorizedBy: "user",
      reviewState: "confirmed"
    }))
  );
  await page.reload();
  await selected(names[0]!).waitFor();
  expect(await selected(names[0]!).isChecked()).toBe(false);
  await selected(names[0]!).check();
  await selected(names[1]!).check();
  await page
    .getByLabel("Category for selected transactions", { exact: true })
    .selectOption("savings");
  await page.getByRole("button", { name: "Review category change", exact: true }).click();
  const other = await context.newPage();
  try {
    await other.goto(`${base}/m/finance/transactions`);
    await other
      .getByRole("checkbox", { name: `Select ${names[0]}`, exact: true })
      .filter({ visible: true })
      .check();
    await other
      .getByLabel("Category for selected transactions", { exact: true })
      .selectOption("dining");
    await other.getByRole("button", { name: "Review category change", exact: true }).click();
    await other
      .getByRole("dialog", { name: "Review selected transactions", exact: true })
      .getByRole("button", { name: "Confirm category change", exact: true })
      .click();
    await other
      .getByRole("dialog", { name: "Confirm Finance action", exact: true })
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    await other
      .getByRole("dialog", { name: "Review selected transactions", exact: true })
      .waitFor({ state: "detached" });
  } finally {
    await other.close();
  }
  const competing = await rows();
  await confirm();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review
    .getByText(
      "A selected record changed. Nothing was saved. Close this review and check saved records before choosing again.",
      { exact: true }
    )
    .waitFor();
  expect(await rows()).toEqual(competing);
  expect(
    await review.getByRole("button", { name: "Confirm category change", exact: true }).isDisabled()
  ).toBe(true);
  await review.getByRole("button", { name: "Back to selection", exact: true }).click();
  expect(await selected(names[0]!).isDisabled()).toBe(true);
  await page
    .getByRole("button", { name: "Check saved records and clear review", exact: true })
    .click();
  await page
    .getByRole("region", { name: "Selected transactions", exact: true })
    .waitFor({ state: "detached" });
  await expect.poll(() => selected(names[0]!).isDisabled()).toBe(false);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  await page.getByLabel("Filter by category", { exact: true }).selectOption("groceries");
  await page.getByRole("button", { name: "Filters · 1", exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: "Filters", exact: true }).click();
  expect(await page.getByLabel("Filter by account", { exact: true }).count()).toBe(0);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-bulk-register-${width}.png`),
        fullPage: true
      });
  }
}
