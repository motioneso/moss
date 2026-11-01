import { exerciseTransactionDetails } from "./finance-live-transaction-details.js";
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
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/transactions`);
    const picker = () =>
      page.getByLabel(`Category for ${record.name}`, { exact: true }).filter({ visible: true });
    await exerciseTransactionDetails(page, record.name, month, read, artifacts);
    // One change saves at once and offers Undo. No dialog opens.
    await picker().selectOption("dining");
    await page
      .getByText(`${record.name} moved to Dining & coffee.`, { exact: true })
      .first()
      .waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await expect.poll(async () => (await saved()).categoryId).toBe("dining");
    expect(await saved()).toMatchObject({ ...record, categoryId: "dining" });
    if (artifacts)
      await page.screenshot({ path: join(resolve(artifacts), "finance-single-change-notice.png") });
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-single-change-notice-390.png")
      });
    await page.setViewportSize({ width: 1440, height: 900 });
    // Undo still works after a search hides the row from the loaded list.
    await page
      .getByLabel("Search payees or notes", { exact: true })
      .fill("nothing-matches-synthetic");
    await page.getByText("No matches", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByText(`${record.name} is back in Groceries.`, { exact: true }).first().waitFor();
    await expect.poll(async () => (await saved()).categoryId).toBe("groceries");
    await page.getByLabel("Search payees or notes", { exact: true }).fill("");
    await page.reload();
    await expect.poll(() => picker().inputValue()).toBe("groceries");

    // A competing financial edit makes the page stale, so nothing is saved.
    await seed(4321);
    const changed = await saved();
    await picker().selectOption("savings");
    await page
      .getByText(`${record.name} changed since this page loaded. Nothing was saved.`, {
        exact: true
      })
      .waitFor();
    expect(await saved()).toEqual(changed);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText("Check saved records before reviewing another category change.", { exact: true })
      .waitFor({ state: "detached" });
    await expect.poll(() => picker().inputValue()).toBe("groceries");
    await picker().selectOption("dining");
    await expect.poll(async () => (await saved()).categoryId).toBe("dining");
    expect(await saved()).toMatchObject({
      amountCents: 4321,
      categoryId: "dining",
      notes: record.notes
    });

    // Needs a look: Confirm keeps the guess in one click.
    await seed(4321, true);
    await page.reload();
    await page.setViewportSize({ width: 1440, height: 900 });
    const row = () =>
      page.getByRole("row").filter({ hasText: record.name }).filter({ visible: true });
    await row()
      .getByRole("button", { name: /^Confirm .* for /, exact: false })
      .click();
    await page
      .getByText(`Confirmed ${record.name} as Groceries.`, { exact: true })
      .first()
      .waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    await expect.poll(async () => (await saved()).categoryId).toBe("groceries");
    expect(await saved()).toMatchObject({ ...record, amountCents: 4321 });
    await page.reload();
    await expect.poll(() => picker().inputValue()).toBe("groceries");
    expect(
      await row()
        .getByRole("button", { name: /^Confirm .* for / })
        .count()
    ).toBe(0);

    // Needs a look: Change opens one picker, Confirm saves the new category.
    await seed(4321, true);
    await page.reload();
    await row()
      .getByRole("button", { name: `Change category for ${record.name}`, exact: true })
      .click();
    await picker().selectOption("dining");
    await row().getByRole("button", { name: "Confirm", exact: true }).click();
    await expect.poll(async () => (await saved()).categoryId).toBe("dining");
    expect(await saved()).toMatchObject({ ...record, amountCents: 4321, categoryId: "dining" });

    // A competing edit after the page loaded saves nothing.
    await seed(4321, true);
    await page.reload();
    await row()
      .getByRole("button", { name: /^Confirm .* for / })
      .waitFor();
    await seed(5678, true);
    const competing = await saved();
    await row()
      .getByRole("button", { name: /^Confirm .* for /, exact: false })
      .click();
    await page
      .getByText(`${record.name} changed since this page loaded. Nothing was saved.`, {
        exact: true
      })
      .waitFor();
    expect(await saved()).toEqual(competing);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText("Check saved records before reviewing another category change.", { exact: true })
      .waitFor({ state: "detached" });
  } finally {
    await page.close();
  }
  await exercisePendingHandoffReview(context, base, workerDb, userId, month, read, artifacts);
}
