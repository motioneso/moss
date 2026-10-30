import { join, resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { expect } from "vitest";
import type { BrowserContext, Locator } from "playwright-core";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import { sqlStore, NS } from "../../../external-modules/finance/src/domain/index.js";

export async function exerciseCardReserves(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  actorUserId: string,
  month: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const withStore = <T>(fn: (s: ReturnType<typeof sqlStore>) => Promise<T>) =>
    new DataContextRunner(db).withDataContext({ actorUserId }, async (scope) => {
      await sql`SELECT set_config('app.current_module_id','finance',true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      return fn(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  const at = `${month}-01T00:00:00Z`;
  const entry = (id: string, amountCents: number) =>
    withStore((s) =>
      s.manual!.createEntry({
        id,
        accountId: "card-proof",
        date: `${month}-01`,
        name: "Synthetic card purchase or refund",
        amountCents,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "Synthetic private note; not part of budget review",
        cleared: false,
        digest: "b".repeat(64),
        at
      })
    );
  await withStore(async (s) => {
    await s.budgetPolicy!.configure("USD", false, at);
    for (const [accountId, type, amount] of [
      ["cash-proof", "depository", 100000],
      ["card-proof", "credit", 50000]
    ] as const)
      expect(
        await s.manual!.createAccount({
          accountId,
          type,
          name: type === "credit" ? "Synthetic reserve card" : "Synthetic reserve cash",
          subtype: type === "credit" ? "credit card" : "checking",
          isoCurrency: "USD",
          openingDate: `${month}-01`,
          openingBalanceCents: amount,
          digest: "a".repeat(64),
          at
        })
      ).toBe("created");
    await s.setAssignment(month, "groceries", 10000);
  });
  await new DataContextRunner(db).withDataContext({ actorUserId }, (scope) =>
    setModuleKvValue(
      scope,
      {
        moduleId: "finance",
        namespace: NS.meta,
        scope: "user",
        ownerUserId: actorUserId,
        key: "storage:migrated"
      },
      { at }
    )
  );
  expect(await entry("card-proof-purchase", 5000)).toBe("created");
  const status = () => read("finance.budget.status", { month });
  const page = await context.newPage();
  const waitForAction = async (action: Locator) => {
    const busy = page.getByRole("alert").filter({ hasText: /Finance is temporarily busy/ });
    await action.and(page.locator(":enabled")).or(busy).first().waitFor();
    if (await busy.isVisible()) {
      const seconds = Number((await busy.innerText()).match(/Wait (\d+) seconds?/)?.[1]);
      expect(Number.isFinite(seconds) && seconds > 0 && seconds <= 60).toBe(true);
      await page.waitForTimeout(seconds * 1000 + 100);
      await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    }
    await action.and(page.locator(":enabled")).waitFor();
  };
  const capture = async (name: string, dialog?: Locator) => {
    for (const [theme, width] of [
      ["light", 1440],
      ["dark", 320]
    ] as const) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      if (dialog) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))
        ).toBe(true);
        const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      }
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-card-${name}-${theme}-${width}.png`),
          fullPage: !dialog
        });
    }
  };
  try {
    expect(await status()).toMatchObject({ readyToAssignCents: 40000, cardPayments: [] });
    await page.goto(`${base}/m/finance`);
    const setupButton = page.getByRole("button", { name: "Set up payment reserve", exact: true });
    await waitForAction(setupButton);
    await setupButton.click();
    const setup = page.getByRole("dialog", { name: "Set up card-payment reserve", exact: true });
    await setup.getByLabel("Cash to assign for starting debt", { exact: true }).fill("100.00");
    await setup.getByRole("button", { name: "Review amounts", exact: true }).click();
    await setup.getByRole("region", { name: "Payment cash preview", exact: true }).waitFor();
    await capture("setup", setup);
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await setup.getByRole("button", { name: "Confirm payment cash", exact: true }).click();
    await guard.waitFor();
    expect((await status()).cardPayments).toEqual([]);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await setup.getByText("Nothing saved. Your review is still here.", { exact: true }).waitFor();
    expect(
      await setup.getByLabel("Cash to assign for starting debt", { exact: true }).inputValue()
    ).toBe("100.00");
    await setup.getByRole("button", { name: "Confirm payment cash", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await setup.waitFor({ state: "detached" });
    expect(await status()).toMatchObject({
      readyToAssignCents: 80000,
      cardPayments: [{ availableCents: 15000, fundedCents: 5000, owedCents: 55000 }]
    });
    await page.reload();
    const reviewButton = page.getByRole("button", { name: "Review payment cash", exact: true });
    await waitForAction(reviewButton);
    await capture("saved");
    const fundDialog = page.getByRole("dialog", { name: "Review card-payment cash", exact: true });
    for (const [amount, ready, available] of [
      ["200.00", 75000, 20000],
      ["0.00", 95000, 0]
    ] as const) {
      await waitForAction(reviewButton);
      await reviewButton.click();
      await fundDialog.getByLabel("Available payment cash", { exact: true }).fill(amount);
      await fundDialog.getByRole("button", { name: "Review amounts", exact: true }).click();
      await fundDialog.getByRole("region", { name: "Payment cash preview", exact: true }).waitFor();
      await fundDialog.getByRole("button", { name: "Confirm payment cash", exact: true }).click();
      await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
      await fundDialog.waitFor({ state: "detached" });
      expect(await status()).toMatchObject({
        readyToAssignCents: ready,
        cardPayments: [{ availableCents: available }]
      });
    }
    // Capture, then change the real SQL ledger before confirming. No mocked stale response.
    await waitForAction(reviewButton);
    await reviewButton.click();
    await fundDialog.getByRole("button", { name: "Review amounts", exact: true }).click();
    await fundDialog.getByRole("region", { name: "Payment cash preview", exact: true }).waitFor();
    expect(await entry("card-proof-refund", -2500)).toBe("created");
    await fundDialog.getByRole("button", { name: "Confirm payment cash", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await fundDialog.getByRole("alert").filter({ hasText: "check saved records" }).waitFor();
    expect(
      await fundDialog
        .getByRole("button", { name: "Confirm payment cash", exact: true })
        .isDisabled()
    ).toBe(true);
    expect(await status()).toMatchObject({
      cardPayments: [{ availableCents: -2500 }],
      targetFundingOverspent: true
    });
    await fundDialog.getByRole("button", { name: "Close", exact: true }).click();
    await page.reload();
    await waitForAction(reviewButton);
    await page.getByText("Payment cash is overspent.", { exact: false }).waitFor();
    await capture("overspent");
    await reviewButton.click();
    await fundDialog.getByRole("button", { name: "Review amounts", exact: true }).click();
    await fundDialog.getByRole("region", { name: "Payment cash preview", exact: true }).waitFor();
    await fundDialog.getByRole("button", { name: "Confirm payment cash", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await fundDialog.waitFor({ state: "detached" });
    expect(await status()).toMatchObject({
      readyToAssignCents: 92500,
      cardPayments: [{ availableCents: 0 }],
      targetFundingOverspent: false
    });
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-card-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
