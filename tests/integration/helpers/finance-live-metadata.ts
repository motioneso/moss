import { join, resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import { expect } from "vitest";
import { exercisePendingHandoffReview } from "./finance-live-pending-handoff.js";
import type { BrowserContext } from "playwright-core";
import {
  NS,
  sqlStore,
  type FinanceDb
} from "../../../external-modules/finance/src/domain/index.js";

export async function exerciseIndividualMetadata(
  context: BrowserContext,
  base: string,
  workerDb: Kysely<MossDatabase>,
  userId: string,
  month: string,
  read: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const runner = new DataContextRunner(workerDb);
  const record = {
    id: "synthetic:metadata-review",
    accountId: "synthetic:metadata-checking",
    date: `${month}-01`,
    amountCents: 1234,
    isoCurrency: "USD",
    name: "Synthetic reviewed market",
    merchant: null,
    plaidCategory: null,
    categoryId: "groceries",
    pending: false,
    pendingTransactionId: null,
    categorizedBy: "user",
    reviewState: "confirmed",
    notes: "Synthetic private context"
  } as const;
  const seed = async (amountCents: number, needsLook = false) =>
    runner.withDataContext({ actorUserId: userId }, async (scope) => {
      await sql`select set_config('app.current_module_id', 'finance', true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      const db: FinanceDb = {
        query: async (text, params) => ({
          rows: [...(await rpc.query(text, params)).rows] as never[]
        })
      };
      const store = sqlStore(db);
      await store.budgetPolicy!.configure("USD", false, `${month}-01T00:00:00Z`);
      await store.putAccount({
        accountId: record.accountId,
        itemId: null,
        name: "Synthetic metadata checking",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: null,
        balanceCents: 10000,
        isoCurrency: "USD",
        updatedAt: `${month}-01T00:00:00Z`
      });
      await store.putTransaction({
        ...record,
        amountCents,
        reviewState: needsLook ? "needs_look" : "confirmed",
        categorizedBy: needsLook ? "rule" : "user"
      });
      await setModuleKvValue(
        scope,
        {
          moduleId: "finance",
          namespace: NS.meta,
          scope: "user",
          ownerUserId: userId,
          key: "storage:migrated"
        },
        { at: new Date().toISOString() }
      );
    });
  await seed(record.amountCents);
  const saved = async () =>
    (
      (await read("finance.transactions.query", { month })).transactions as Record<
        string,
        unknown
      >[]
    ).find((row) => row.id === record.id)!;
  const original = await saved();
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/transactions`);
    const picker = () =>
      page.getByLabel(`Category for ${record.name}`, { exact: true }).filter({ visible: true });
    await picker().selectOption("dining");
    const review = page.getByRole("dialog", { name: "Review category change", exact: true });
    await review.getByText("Groceries → Dining & coffee", { exact: true }).waitFor();
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
            path: join(resolve(artifacts), `finance-individual-review-${theme}-${width}.png`)
          });
      }
    }
    const submit = () =>
      review.getByRole("button", { name: "Confirm category change", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await submit();
    await guard.waitFor();
    expect(await saved()).toEqual(original);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await review
      .getByText("Cancelled. Your selection and category are kept.", { exact: true })
      .waitFor();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(await saved()).toMatchObject({ ...record, categoryId: "dining" });
    await page.reload();
    await expect.poll(() => picker().inputValue()).toBe("dining");
    await picker().selectOption("savings");
    await review.waitFor();
    await seed(4321);
    const changed = await saved();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review
      .getByText(
        "A selected record changed. Nothing was saved. Close this review and check saved records before choosing again.",
        { exact: true }
      )
      .waitFor();
    expect(await saved()).toEqual(changed);
    expect(
      await review
        .getByRole("button", { name: "Confirm category change", exact: true })
        .isDisabled()
    ).toBe(true);
    await review.getByRole("button", { name: "Back to transactions", exact: true }).click();
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText("Check saved records before reviewing another category change.", { exact: true })
      .waitFor({ state: "detached" });
    await expect.poll(() => picker().inputValue()).toBe("groceries");
    await picker().selectOption("dining");
    await review.waitFor();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(await saved()).toMatchObject({
      amountCents: 4321,
      categoryId: "dining",
      notes: record.notes
    });

    // The individual Needs a look path must use the same real host guard and SQL receipt.
    await seed(4321, true);
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    const row = () =>
      page.getByRole("row").filter({ hasText: record.name }).filter({ visible: true });
    const confirmOne = () => row().getByRole("button", { name: "Confirm", exact: true }).click();
    await confirmOne();
    const confirmation = page.getByRole("dialog", {
      name: "Review transaction category",
      exact: true
    });
    await confirmation.getByText("Existing category · Groceries", { exact: true }).waitFor();
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        expect(await confirmation.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
        const footer = await confirmation.locator(".jds-dialog__foot").boundingBox();
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-single-confirm-${theme}-${width}.png`)
          });
      }
    }
    const confirmCategory = () =>
      confirmation.getByRole("button", { name: "Confirm category", exact: true }).click();
    const beforeConfirmation = await saved();
    await confirmCategory();
    await guard.waitFor();
    expect(await saved()).toEqual(beforeConfirmation);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await confirmation
      .getByText("Cancelled. Your selection and category are kept.", { exact: true })
      .waitFor();
    expect(await saved()).toEqual(beforeConfirmation);
    await confirmCategory();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await confirmation.waitFor({ state: "detached" });
    expect(await saved()).toMatchObject({ ...record, amountCents: 4321 });
    await page.reload();
    await expect.poll(() => picker().inputValue()).toBe("groceries");
    expect(await row().getByRole("button", { name: "Confirm", exact: true }).count()).toBe(0);

    // A deliberately changed guess uses the captured category-change writer instead.
    await seed(4321, true);
    await page.reload();
    await picker().selectOption("dining");
    await confirmOne();
    await review.getByText("Groceries → Dining & coffee", { exact: true }).waitFor();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(await saved()).toMatchObject({ ...record, amountCents: 4321, categoryId: "dining" });

    // A competing financial edit invalidates the original confirmation, saving nothing.
    await seed(4321, true);
    await page.reload();
    await confirmOne();
    await confirmation.waitFor();
    await seed(5678, true);
    const competing = await saved();
    await confirmCategory();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await confirmation
      .getByText(
        "A selected record changed. Nothing was saved. Close this review and check saved records before choosing again.",
        { exact: true }
      )
      .waitFor();
    expect(await saved()).toEqual(competing);
    expect(
      await confirmation.getByRole("button", { name: "Confirm category", exact: true }).isDisabled()
    ).toBe(true);
    await confirmation.getByRole("button", { name: "Back to transactions", exact: true }).click();
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText("Check saved records before reviewing another category change.", { exact: true })
      .waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
  await exercisePendingHandoffReview(context, base, workerDb, userId, month, read, artifacts);
}
