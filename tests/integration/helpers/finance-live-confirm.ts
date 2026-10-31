import { join, resolve } from "node:path";
import { expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import type { BrowserContext } from "playwright-core";
import {
  sqlStore,
  type TransactionRecord
} from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseCategoryConfirmation(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  userId: string,
  month: string,
  read: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const owner = <T>(run: (store: ReturnType<typeof sqlStore>) => Promise<T>) =>
    new DataContextRunner(db).withDataContext({ actorUserId: userId }, async (scope) => {
      await sql`select set_config('app.current_module_id','finance',true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      return run(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  const row = (id: string, extra: Partial<TransactionRecord> = {}): TransactionRecord => ({
    id: `review:${id}`,
    accountId: "synthetic-cash",
    date: `${month}-03`,
    name: `Synthetic category review ${id}`,
    amountCents: 1251,
    isoCurrency: "USD",
    categoryId: "utilities",
    pending: false,
    pendingTransactionId: null,
    merchant: null,
    plaidCategory: null,
    categorizedBy: "ai",
    reviewState: "needs_look",
    notes: "Synthetic retained review note",
    ...extra
  });
  await owner(async (s) => {
    expect(["created", "unchanged"]).toContain(
      await s.budgetPolicy!.configure("USD", false, new Date().toISOString())
    );
    for (const entry of [
      row("A"),
      row("B", { amountCents: -301, categoryId: "groceries" }),
      row("pending", { pending: true }),
      row("split", { splits: [{ categoryId: "utilities", amountCents: 1251 }] })
    ])
      await s.putTransaction(entry);
  });
  const saved = async () =>
    (
      await read("finance.transactions.query", {
        month,
        search: "Synthetic category review",
        limit: 200
      })
    ).transactions as TransactionRecord[];
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/transactions`);
    await page
      .getByLabel("Search payees or notes", { exact: true })
      .fill("Synthetic category review");
    await page.getByRole("button", { name: "Review 2 categories", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review transaction categories", exact: true });
    await review.getByText("Synthetic category review A", { exact: true }).waitFor();
    expect(
      await review.getByText("Synthetic category review pending", { exact: true }).count()
    ).toBe(0);
    expect(await review.getByText("Synthetic category review split", { exact: true }).count()).toBe(
      0
    );
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-confirm-review-${theme}-${width}.png`),
            fullPage: true
          });
      }
    }
    await review.getByRole("button", { name: "Confirm reviewed categories", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(
      (await saved())
        .filter((r) => ["review:A", "review:B"].includes(r.id))
        .every((r) => r.reviewState === "confirmed")
    ).toBe(true);
    await owner(async (s) => {
      await s.putTransaction(row("C"));
      await s.putTransaction(row("D"));
    });
    await page.reload();
    await page
      .getByLabel("Search payees or notes", { exact: true })
      .fill("Synthetic category review");
    await page.getByRole("button", { name: "Review 2 categories", exact: true }).click();
    // Synthetic competing owner action uses the actual Finance SQL store, not a response mock.
    await owner(async (s) => {
      const target = (await s.bulk!.monthRows(month)).find((r) => r.id === "review:D")!;
      expect(await s.bulk!.categorize([target], "dining")).toBe(true);
    });
    await review.getByRole("button", { name: "Confirm reviewed categories", exact: true }).click();
    await review
      .getByText(
        "A reviewed transaction or category changed. Nothing was confirmed. Close this review and check saved records.",
        { exact: true }
      )
      .waitFor();
    expect(
      await review
        .getByRole("button", { name: "Confirm reviewed categories", exact: true })
        .isDisabled()
    ).toBe(true);
    expect((await saved()).find((r) => r.id === "review:C")?.reviewState).toBe("needs_look");
    await review.getByRole("button", { name: "Back to register", exact: true }).click();
    await context.setOffline(true);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByText(
        "The register could not be refreshed. Try checking again; no confirmation has been assumed.",
        { exact: true }
      )
      .waitFor();
    await page.getByRole("button", { name: "Retry register", exact: true }).click();
    await page.getByRole("button", { name: "Retry register", exact: true }).waitFor();
    await context.setOffline(false);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    const one = page.getByRole("button", { name: "Review 1 category", exact: true });
    await one.waitFor();
    await one.click({ trial: true });
    await one.focus();
    await one.press("Enter");
    await review.getByText("Synthetic category review C", { exact: true }).waitFor();
    expect(await review.getByText("Synthetic category review D", { exact: true }).count()).toBe(0);
    const committed = page.waitForResponse((response) =>
      response.url().includes("/api/modules/finance/tools/finance.transactions.confirm/invoke")
    );
    await review.getByRole("button", { name: "Confirm reviewed categories", exact: true }).click();
    const reply = await committed;
    expect({ http: reply.status(), body: await reply.json() }).toMatchObject({
      http: 200,
      body: { invocation: { status: "succeeded", result: { status: "ok", confirmed: 1 } } }
    });
    await review.waitFor({ state: "detached" });
    await page.reload();
    const rows = await saved();
    expect(
      rows
        .filter((r) => ["review:A", "review:B", "review:C", "review:D"].includes(r.id))
        .every((r) => r.reviewState === "confirmed")
    ).toBe(true);
    expect(rows.find((r) => r.id === "review:pending")?.reviewState).toBe("needs_look");
    expect(rows.find((r) => r.id === "review:split")?.splits).toEqual([
      { categoryId: "utilities", amountCents: 1251 }
    ]);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-confirm-review-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await context.setOffline(false);
    await page.close();
  }
}
