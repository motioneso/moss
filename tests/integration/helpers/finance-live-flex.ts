import { waitForFinanceAction } from "./finance-live-ready.js";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";
import { FLEX_POOL } from "../../../external-modules/finance/src/domain/flex.js";
type Read = (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseFlex(
  page: Page,
  base: string,
  month: string,
  read: Read,
  artifacts?: string,
  repairLegacyTarget?: () => Promise<void>
) {
  const before = await read("finance.transactions.query", { month });
  await page.goto(`${base}/m/finance`);
  const setupAction = page.getByRole("button", { name: "Set up flexible budget", exact: true });
  await waitForFinanceAction(page, setupAction);
  await setupAction.click();
  const setup = page.getByRole("dialog", { name: "Set up a flexible budget", exact: true });
  const original = await read("finance.budget.status", { month });
  const starting = (
    original.state as {
      categories: Record<string, { assignedCents: number; availableCents: number }>;
    }
  ).categories;
  const returnedAssignment = (id: string, available: number) =>
    available + (starting[id]?.assignedCents ?? 0) - (starting[id]?.availableCents ?? 0);

  for (const c of original.flexChoices as { id: string; name: string }[])
    await setup
      .getByLabel(`Grouping for ${c.name}`, { exact: true })
      .selectOption(
        ["groceries", "dining"].includes(c.id)
          ? "flex"
          : c.id === "savings"
            ? "nonmonthly"
            : "fixed"
      );
  await setup.getByRole("button", { name: "Review mode change", exact: true }).click();
  await setup.getByRole("region", { name: "Mode change preview", exact: true }).waitFor();
  await setup.getByRole("button", { name: "Confirm mode change", exact: true }).click();
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  await guard.waitFor();
  expect((await read("finance.budget.status", { month })).flex).toBeNull();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await setup.getByText("Cancelled. Your choices and preview are kept.", { exact: true }).waitFor();
  await setup.getByRole("button", { name: "Confirm mode change", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await setup.waitFor({ state: "detached" });
  if (repairLegacyTarget) await repairLegacyTarget();
  const field = () =>
    page.getByLabel("Assigned to Flexible spending", { exact: true }).filter({ visible: true });
  await field().waitFor();
  expect(await page.getByLabel("Assigned to Groceries", { exact: true }).count()).toBe(0);
  await field().fill("200.00");
  await field().press("Enter");
  await guard.waitFor();
  expect((await read("finance.budget.status", { month })).state).toMatchObject({
    categories: { [FLEX_POOL]: { assignedCents: 0 } }
  });
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await expect.poll(() => field().inputValue()).toBe("$200.00");
  expect((await read("finance.budget.status", { month })).state).toMatchObject({
    categories: {
      [FLEX_POOL]: { assignedCents: 20000, activityCents: 8243, availableCents: 11757 }
    }
  });
  await page.getByRole("button", { name: "See flexible spending detail", exact: true }).click();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-flex-${theme}-${width}.png`),
          fullPage: true
        });
    }
  }
  const [year, index] = month.split("-").map(Number);
  const next = index === 12 ? `${year! + 1}-01` : `${year}-${String(index! + 1).padStart(2, "0")}`;
  expect((await read("finance.budget.status", { month: next })).state).toMatchObject({
    categories: { [FLEX_POOL]: { assignedCents: 0, availableCents: 11757 } }
  });
  await page.getByRole("button", { name: "Return to envelopes", exact: true }).click();
  const exit = page.getByRole("dialog", { name: "Return to category envelopes", exact: true });
  await exit.getByLabel("Available for Groceries", { exact: true }).fill("100.00");
  await exit.getByLabel("Available for Dining & coffee", { exact: true }).fill("17.57");
  await exit.getByRole("button", { name: "Review mode change", exact: true }).click();
  await exit.getByRole("region", { name: "Mode change preview", exact: true }).waitFor();
  for (const [theme, width] of [
    ["dark", 320],
    ["light", 1440]
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    const footer = await exit.locator(".jds-dialog__foot").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-flex-exit-${theme}-${width}.png`),
        fullPage: false
      });
  }
  await exit.getByRole("button", { name: "Confirm mode change", exact: true }).click();
  await guard.waitFor();
  expect((await read("finance.budget.status", { month })).flex).toMatchObject({ active: true });
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await exit.waitFor({ state: "detached" });
  expect((await read("finance.budget.status", { month })).state).toMatchObject({
    categories: {
      groceries: { assignedCents: returnedAssignment("groceries", 10000), availableCents: 10000 },
      dining: { assignedCents: returnedAssignment("dining", 1757), availableCents: 1757 },
      [FLEX_POOL]: { availableCents: 0 }
    }
  });
  await page.reload();
  await page
    .getByLabel("Assigned to Groceries", { exact: true })
    .filter({ visible: true })
    .waitFor();
  expect(await read("finance.transactions.query", { month })).toEqual(before);
  // Return this shared synthetic fixture to its former zero assignments for later ledger flows.
  for (const name of ["Groceries", "Dining & coffee"]) {
    const input = page.getByLabel(`Assigned to ${name}`, { exact: true }).filter({ visible: true });
    await input.fill("0.00");
    await input.press("Enter");
    if (name === "Groceries") {
      await guard.waitFor();
      await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    }
    await expect.poll(() => input.inputValue()).toBe("$0.00");
  }
}
