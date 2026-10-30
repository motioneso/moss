import { join, resolve } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { expect } from "vitest";
import type { TargetFundingLine } from "../../../external-modules/finance/src/domain/target-funding.js";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
export async function exerciseTargetFunding(
  context: BrowserContext,
  base: string,
  month: string,
  read: Read,
  artifacts?: string
) {
  const page = await context.newPage();
  const status = () => read("finance.budget.status", { month });
  const assigned = async () => ({
    categories: (
      (await status()).state as { categories: Record<string, { assignedCents: number }> }
    ).categories
  });
  const open = (p: Page) =>
    p
      .getByRole("region", { name: "Category targets", exact: true })
      .getByRole("button", { name: "Review target funding", exact: true })
      .click();
  const createTarget = async (category: string, amount: string, dated = false) => {
    await page.getByRole("button", { name: "Add a target", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add a target", exact: true });
    await dialog.getByLabel("Target category", { exact: true }).selectOption(category);
    await dialog.getByLabel("Target amount", { exact: true }).fill(amount);
    if (dated) {
      await dialog.getByLabel("Target type", { exact: true }).selectOption("balance");
      await dialog.getByLabel("Target date", { exact: true }).fill(`${month}-28`);
    }
    await dialog.getByRole("button", { name: "Save target", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  };
  const editGroceries = async (p: Page, amount: string) => {
    await p
      .getByRole("region", { name: "Category targets", exact: true })
      .locator(".jds-index__row")
      .filter({ hasText: "Groceries" })
      .getByRole("button", { name: "Edit target", exact: true })
      .click();
    const edit = p.getByRole("dialog", { name: "Edit target", exact: true });
    await edit.getByLabel("Target amount", { exact: true }).fill(amount);
    await edit.getByRole("button", { name: "Save target", exact: true }).click();
    await edit.waitFor({ state: "detached" });
  };
  try {
    await page.goto(`${base}/m/finance`);
    await page.getByRole("heading", { name: "Plan for what matters", exact: true }).waitFor();
    const before = {
      accounts: await read("finance.accounts.list"),
      transactions: await read("finance.transactions.query", { month, ownOnly: true })
    };
    await createTarget("groceries", "300.01");
    await createTarget("savings", "100.01", true);
    const view = await status(),
      original = await assigned();
    const suggestions = view.targetFunding as TargetFundingLine[];
    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ categoryId: "groceries", amountCents: 5001 }),
        expect.objectContaining({ categoryId: "savings", amountCents: 10001 })
      ])
    );
    await open(page);
    const form = page.getByRole("dialog", { name: "Choose target funding", exact: true });
    const review = page.getByRole("dialog", { name: "Review target assignments", exact: true });
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    expect(
      await form.getByRole("button", { name: "Review selected amounts", exact: true }).isDisabled()
    ).toBe(true);
    const groceries = form.getByRole("checkbox", { name: "Fund Groceries", exact: true });
    await groceries.focus();
    await groceries.press("Space");
    expect(await groceries.isChecked()).toBe(true);
    const select = (name: string) => form.getByText(name, { exact: true }).click();
    await select("Savings");
    const inspect = async (dialog: typeof form, label: string) => {
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
          const bounds = (await dialog.boundingBox())!;
          for (const control of await dialog
            .locator('button,input:not([type="checkbox"]),select,label')
            .all()) {
            const box = await control.boundingBox();
            if (box) {
              expect(box.x).toBeGreaterThanOrEqual(bounds.x);
              expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
            }
          }
          const footer = (await dialog.locator(".jds-dialog__foot").boundingBox())!;
          expect(footer.y + footer.height).toBeLessThanOrEqual(900);
          if (artifacts)
            await page.screenshot({
              path: join(
                resolve(artifacts),
                `finance-target-funding-${label}-${theme}-${width}.png`
              )
            });
        }
      }
    };
    await inspect(form, "selection");
    await form.getByRole("button", { name: "Review selected amounts", exact: true }).click();
    await review.getByText("$250.00 → $300.01", { exact: true }).waitFor();
    await inspect(review, "review");
    await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
    await guard.waitFor();
    expect(await assigned()).toEqual(original);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await review
      .getByText("Cancelled. Your captured funding selection is kept.", { exact: true })
      .waitFor();
    expect(await assigned()).toEqual(original);
    await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await page.reload();
    expect(await assigned()).toMatchObject({
      categories: { groceries: { assignedCents: 30001 }, savings: { assignedCents: 10001 } }
    });
    expect((await status()).readyToAssignCents).toBe((view.readyToAssignCents as number) - 15002);
    await editGroceries(page, "400.01");
    await open(page);
    await select("Groceries");
    await form.getByRole("button", { name: "Review selected amounts", exact: true }).click();
    const other = await context.newPage();
    try {
      await other.goto(`${base}/m/finance`);
      await editGroceries(other, "400.02");
    } finally {
      await other.close();
    }
    await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.getByText(/The budget or target guidance changed/).waitFor();
    expect(
      await review
        .getByRole("button", { name: "Confirm target assignments", exact: true })
        .isDisabled()
    ).toBe(true);
    expect(await assigned()).toMatchObject({ categories: { groceries: { assignedCents: 30001 } } });
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      await page.getByRole("button", { name: "Review target funding", exact: true }).isDisabled()
    ).toBe(true);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText("Saved records refreshed. Review your typed amounts before saving.", {
        exact: true
      })
      .waitFor();
    await open(page);
    await select("Groceries");
    await form.getByRole("button", { name: "Review selected amounts", exact: true }).click();
    await review.getByRole("button", { name: "Confirm target assignments", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(await assigned()).toMatchObject({
      categories: { groceries: { assignedCents: 40002 }, savings: { assignedCents: 10001 } }
    });
    expect(await read("finance.accounts.list")).toEqual(before.accounts);
    expect(await read("finance.transactions.query", { month, ownOnly: true })).toEqual(
      before.transactions
    );
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-target-funding-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
