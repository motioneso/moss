import { exerciseTransferCorrection } from "./finance-live-transfer-corrections.js";
import { setModuleKvValue } from "@moss/settings";
import { readyToAssignCents } from "../../../external-modules/finance/src/domain/ready-to-assign.js";
import { NS } from "../../../external-modules/finance/src/domain/index.js";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import type { BrowserContext } from "playwright-core";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseManualTransfers(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  userId: string,
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
  const today = String((await read("finance.manual.context")).today);
  await owner(async (s) => {
    for (const [id, name, type, currency, balance] of [
      ["manual:transfer-cash", "Synthetic transfer checking", "depository", "USD", 10000],
      ["manual:transfer-savings", "Synthetic transfer savings", "depository", "USD", 0],
      ["manual:transfer-card", "Synthetic transfer card", "credit", "USD", 5000],
      ["manual:transfer-euro", "Synthetic transfer euro", "depository", "EUR", 0]
    ] as const)
      expect(
        await s.manual!.createAccount({
          accountId: id,
          name,
          type,
          subtype: "checking",
          isoCurrency: currency,
          openingDate: today,
          openingBalanceCents: balance,
          digest: "a".repeat(64),
          at: new Date().toISOString()
        })
      ).toBe("created");
  });
  const balance = (id: string) => owner(async (s) => (await s.getAccount(id))!.balanceCents);
  // Synthetic fixture setup matches the existing installed Finance SQL fixtures. Migration itself
  // is covered separately; this actor starts with no legacy KV financial records.
  await new DataContextRunner(db).withDataContext({ actorUserId: userId }, async (scope) => {
    await sql`select set_config('app.current_module_id','finance',true)`.execute(scope.db);
    return setModuleKvValue(
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
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/accounts`);
    await page.getByRole("button", { name: "Record transfer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Record a manual transfer", exact: true });
    await dialog.getByLabel("From account", { exact: true }).selectOption("manual:transfer-euro");
    await dialog
      .getByText("No other eligible EUR ledger is available. Add one in Accounts first.", {
        exact: true
      })
      .waitFor();
    await dialog.getByLabel("From account", { exact: true }).selectOption("manual:transfer-cash");
    expect(
      await dialog.getByLabel("To account", { exact: true }).getByRole("option").allTextContents()
    ).not.toContain("Synthetic transfer euro · EUR");
    await dialog.getByLabel("To account", { exact: true }).selectOption("manual:transfer-savings");
    await dialog.getByLabel("Transfer amount USD", { exact: true }).fill("12.34");
    await dialog
      .getByRole("checkbox", { name: "Both transfer entries are cleared", exact: true })
      .check();
    await dialog.getByRole("button", { name: "Review transfer", exact: true }).click();
    await dialog
      .getByText("Two linked entries will be saved together.", { exact: false })
      .waitFor();
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
            path: join(resolve(artifacts), `finance-transfer-review-${theme}-${width}.png`),
            fullPage: true
          });
      }
    }
    await dialog.getByRole("button", { name: "Record linked transfer", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await guard.waitFor();
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await dialog
      .getByText("Cancelled. Your captured transfer is kept; no new movement was recorded.", {
        exact: true
      })
      .waitFor();
    expect(await balance("manual:transfer-cash")).toBe(10000);
    expect(await balance("manual:transfer-savings")).toBe(0);
    await dialog.getByRole("button", { name: "Record linked transfer", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await balance("manual:transfer-cash")).toBe(8766);
    expect(await balance("manual:transfer-savings")).toBe(1234);
    const rows = (
      await read("finance.transactions.query", { month: today.slice(0, 7), ownOnly: true })
    ).transactions as { id: string; transferId?: string; amountCents: number }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.transferId).toBeTruthy();
    expect(rows[0]!.transferId).toBe(rows[1]!.transferId);
    expect(rows[0]!.amountCents + rows[1]!.amountCents).toBe(0);
    expect(await read("finance.reports.net-worth", { currency: "USD", months: 1 })).toMatchObject({
      headlineCents: 5000
    });
    const spending = (await read("finance.reports.spending", { currency: "USD", months: 1 }))
      .own as { cashFlow: { incomeCents: number; outflowCents: number; netCents: number } }[];
    expect(spending).toHaveLength(1);
    expect(spending[0]!.cashFlow).toEqual({ incomeCents: 0, outflowCents: 0, netCents: 0 });
    expect(
      await owner(async (s) =>
        readyToAssignCents(
          (await s.listAccounts()).filter((a) => a.isoCurrency === "USD"),
          {}
        )
      )
    ).toBe(5000);
    const exported = await read("finance.transactions.export", {});
    expect(String(exported.csv)).toContain("Transfer ID");
    expect(String(exported.csv)).toContain(rows[0]!.transferId!);
    await page.reload();
    await page.getByRole("button", { name: "Record transfer", exact: true }).click();
    await dialog.getByLabel("From account", { exact: true }).selectOption("manual:transfer-cash");
    await dialog.getByLabel("To account", { exact: true }).selectOption("manual:transfer-card");
    await dialog.getByLabel("Transfer amount USD", { exact: true }).fill("3.45");
    await dialog.getByRole("button", { name: "Review transfer", exact: true }).click();
    await owner(async (s) =>
      expect(
        await s.manual!.createEntry({
          id: "manual:transfer-competing",
          accountId: "manual:transfer-cash",
          date: today,
          name: "Synthetic competing entry",
          amountCents: 1,
          isoCurrency: "USD",
          categoryId: null,
          notes: "",
          cleared: false,
          digest: "f".repeat(64),
          at: new Date().toISOString()
        })
      ).toBe("created")
    );
    await dialog.getByRole("button", { name: "Record linked transfer", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await dialog
      .getByText(
        "One of these ledgers changed or no longer accepts this date. No transfer was recorded. Review both saved accounts before trying again.",
        { exact: true }
      )
      .waitFor();
    expect(
      await dialog.getByRole("button", { name: "Record linked transfer", exact: true }).isDisabled()
    ).toBe(true);
    expect(await balance("manual:transfer-cash")).toBe(8765);
    expect(await balance("manual:transfer-card")).toBe(5000);
    await dialog.getByRole("button", { name: "Review saved accounts", exact: true }).click();
    await dialog.getByRole("button", { name: "Review transfer", exact: true }).click();
    await dialog.getByRole("button", { name: "Record linked transfer", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    expect(await balance("manual:transfer-cash")).toBe(8420);
    expect(await balance("manual:transfer-card")).toBe(4655);
    await page.goto(`${base}/m/finance/transactions`);
    await page.getByLabel("Search payees or notes", { exact: true }).fill("Manual transfer");
    await page.getByText("Linked transfer", { exact: true }).first().waitFor();
    expect(await page.getByRole("button", { name: /Split Manual transfer/ }).count()).toBe(0);
    expect(await page.getByLabel(/Category for Manual transfer/).count()).toBe(0);
    await exerciseTransferCorrection(page, read, today, artifacts);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-transfers-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
