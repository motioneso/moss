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
  await page.getByRole("button", { name: "Add a target", exact: true }).click();
  const targetDialog = page.getByRole("dialog", { name: "Add a target", exact: true });
  await targetDialog.getByLabel("Target category", { exact: true }).selectOption("savings");
  await targetDialog.getByLabel("Target amount", { exact: true }).fill("123.45");
  await targetDialog.getByRole("button", { name: "Save target", exact: true }).click();
  await targetDialog.waitFor({ state: "detached" });
  await page
    .getByRole("region", { name: "Category targets", exact: true })
    .getByText(/123.45/)
    .waitFor();
  expect((await read("finance.budget.status", { month })).targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ categoryId: "savings", kind: "monthly", amountCents: 12345 })
    ])
  );
  await page.getByRole("button", { name: "Edit target", exact: true }).click();
  const editTarget = page.getByRole("dialog", { name: "Edit target", exact: true });
  await editTarget.getByLabel("Target type", { exact: true }).selectOption("balance");
  await editTarget.getByLabel("Target amount", { exact: true }).fill("1000.01");
  await editTarget
    .getByLabel("Target date", { exact: true })
    .fill(`${Number(month.slice(0, 4)) + 1}-02-28`);
  for (const [mode, width] of [
    ["dark", 320],
    ["light", 1440]
  ] as const) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    await page.setViewportSize({ width, height: 900 });
    expect(await editTarget.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      false
    );
    for (const button of await editTarget.getByRole("button").all()) {
      const box = await button.boundingBox();
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
    }
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-target-editor-${mode}-${width}.png`),
        fullPage: true
      });
  }
  await editTarget.getByRole("button", { name: "Save target", exact: true }).click();
  await editTarget.waitFor({ state: "detached" });
  await page
    .getByRole("region", { name: "Category targets", exact: true })
    .getByText(/Balance by/)
    .waitFor();
  expect((await read("finance.budget.status", { month })).targets).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "balance",
        amountCents: 100001,
        dueDate: `${Number(month.slice(0, 4)) + 1}-02-28`
      })
    ])
  );
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
  expect(await save().isDisabled()).toBe(true);
  const check = () =>
    page.getByRole("button", { name: "Check saved records", exact: true }).click();
  const [checked] = await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes("/assistant-tools/finance.budget.status/invoke")
    ),
    check()
  ]);
  if (checked.status() === 429) {
    const seconds = Number(await checked.headerValue("retry-after"));
    expect(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
    await page.waitForTimeout(seconds * 1000 + 100);
    await check();
  } else expect(checked.status()).toBe(200);
  await page
    .getByText("Saved records refreshed. Review your typed amounts before saving.", { exact: true })
    .waitFor();
  expect(await field().inputValue()).toBe("500.00");
  expect(await assigned()).toBe(26000);
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
