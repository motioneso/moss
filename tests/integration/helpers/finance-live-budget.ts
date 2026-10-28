import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";

type Read = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseBudgetWrites(
  page: Page,
  read: Read,
  month: string,
  artifacts?: string
) {
  const field = () =>
    page.getByLabel("Assigned to Groceries", { exact: true }).filter({ visible: true });
  const save = () =>
    page
      .getByRole("button", { name: "Save assignment to Groceries", exact: true })
      .filter({ visible: true });
  const dialog = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  const assigned = async () => {
    const budget = await read("finance.budget.status", { month });
    return (
      (budget.state as { categories: Record<string, { assignedCents: number }> }).categories
        .groceries?.assignedCents ?? 0
    );
  };
  await field().fill("250.00");
  await field().press("Enter");
  await dialog.waitFor();
  expect(await assigned()).toBe(0);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByText("Cancelled. Your typed amount is kept.", { exact: true })
    .filter({ visible: true })
    .waitFor();
  expect(await field().inputValue()).toBe("250.00");
  await save().click();
  await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await expect.poll(assigned).toBe(25000);
  await expect.poll(() => field().inputValue()).toBe("$250.00");
  await field().fill("500.00");
  await field().press("Enter");
  await dialog.waitFor();
  const other = await page.context().newPage();
  try {
    await other.goto(page.url());
    const otherField = other
      .getByLabel("Assigned to Groceries", { exact: true })
      .filter({ visible: true });
    await otherField.fill("260.00");
    await otherField.press("Enter");
    await expect.poll(assigned).toBe(26000);
  } finally {
    await other.close();
  }
  await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await page
    .getByText("Not saved. The budget may have changed. Refresh and review your typed amount.", {
      exact: true
    })
    .filter({ visible: true })
    .waitFor();
  expect(await field().inputValue()).toBe("500.00");
  expect(await assigned()).toBe(26000);
  for (const mode of ["light", "dark", "sage"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-budget-stale-${mode}-${width}.png`),
          fullPage: true
        });
    }
  }
  await save().click();
  await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await expect.poll(assigned).toBe(50000);
  await expect.poll(() => field().inputValue()).toBe("$500.00");
  await field().fill("0.00");
  await field().press("Enter");
  await dialog.getByRole("button", { name: "Confirm action", exact: true }).click();
  await expect.poll(assigned).toBe(0);
}

export async function exerciseFirstBudget(
  page: Page,
  base: string,
  read: Read,
  month: string,
  artifacts?: string
) {
  await page.goto(`${base}/m/finance`);
  await page.getByLabel("Budget currency", { exact: true }).selectOption("USD");
  await page.getByRole("button", { name: "Review currency choice", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await confirm.getByRole("button", { name: "Confirm action", exact: true }).click();
  await page
    .getByLabel("Assigned to Groceries", { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.goto(`${base}/m/finance/start`);
  const field = () =>
    page.getByLabel("Plan for Groceries", { exact: true }).filter({ visible: true });
  await field().waitFor();
  const before = await read("finance.budget.draft.get", {});
  expect(before.draft).toMatchObject({
    status: "open",
    totalCents: 30000,
    monthlyIncomeCents: 400000
  });
  await field().fill("350.00");
  await field().press("Enter");
  await expect.poll(() => field().inputValue()).toBe("$350.00");
  expect((await read("finance.budget.draft.get", {})).draft).toMatchObject({ totalCents: 35000 });
  for (const mode of ["light", "dark", "sage"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-first-budget-${mode}-${width}.png`),
          fullPage: true
        });
    }
  }
  const start = page.getByRole("button", { name: "Start this budget", exact: true });
  await start.click();
  await confirm.waitFor();
  expect((await read("finance.budget.draft.get", {})).draft).toMatchObject({ status: "open" });
  await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByText("Cancelled. Your draft and typed amounts are kept.", { exact: true })
    .waitFor();
  await start.click();
  await confirm.getByRole("button", { name: "Confirm action", exact: true }).click();
  await page
    .getByLabel("Assigned to Groceries", { exact: true })
    .filter({ visible: true })
    .waitFor();
  await page.reload();
  await expect
    .poll(() =>
      page
        .getByLabel("Assigned to Groceries", { exact: true })
        .filter({ visible: true })
        .inputValue()
    )
    .toBe("$350.00");
  expect((await read("finance.budget.draft.get", {})).draft).toMatchObject({
    status: "started",
    totalCents: 35000
  });
  expect((await read("finance.budget.status", { month })).state).toMatchObject({
    categories: { groceries: { assignedCents: 35000 } }
  });
}
