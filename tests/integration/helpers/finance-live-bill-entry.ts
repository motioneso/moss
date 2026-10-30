import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext, Locator } from "playwright-core";
import type { Kysely } from "kysely";
import { DataContextRunner, createModuleStorageRpc, type MossDatabase } from "@moss/db";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseBillEntry(
  context: BrowserContext,
  base: string,
  month: string,
  db: Kysely<MossDatabase>,
  actorUserId: string,
  artifacts?: string
) {
  const runner = new DataContextRunner(db);
  const owned = <T>(action: (store: ReturnType<typeof sqlStore>) => Promise<T>) =>
    runner.withDataContext({ actorUserId }, (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      return action(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  const accountId = "manual:due-bill-proof",
    planId = randomUUID(),
    at = `${month}-01T00:00:00Z`;
  const plan = {
    id: planId,
    accountId,
    name: "Synthetic due bill record",
    categoryId: "utilities",
    isoCurrency: "USD",
    amountCents: 10001,
    anchorDate: `${month}-01`,
    cadence: "once" as const
  };
  await owned(async (s) => {
    if (!(await s.budgetPolicy!.get())) await s.budgetPolicy!.configure("USD", false, at);
    expect((await s.budgetPolicy!.get())!.isoCurrency).toBe("USD");
    expect(
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic bill checking",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: `${month}-01`,
        openingBalanceCents: 100000,
        digest: "e".repeat(64),
        at
      })
    ).toBe("created");
    expect(await s.bills!.create(plan, (await s.budgetPolicy!.get())!, at)).toBe(true);
  });
  const snapshot = () =>
    owned(async (s) => ({
      account: await s.getAccount(accountId),
      transactions: await s.getTransactionChunk(accountId, month),
      decisions: (await s.bills!.decisions(`${month}-01`, `${month}-28`)).filter(
        (d) => d.planId === planId
      ),
      revision: (await s.budgetPolicy!.get())!.revision
    }));
  const page = await context.newPage();
  const capture = async (name: string, dialog: Locator) => {
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
      expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))
      ).toBe(true);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-bill-entry-${name}-${theme}-${width}.png`)
        });
    }
  };
  const button = (name: string) =>
    page
      .locator(".jds-index__row")
      .filter({ hasText: name })
      .getByRole("button", { name: "Record bill entry", exact: true });
  const edit = page.getByRole("dialog", { name: "Record bill entry", exact: true });
  const review = page.getByRole("dialog", { name: "Review bill entry", exact: true });
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  try {
    await page.goto(`${base}/m/finance/upcoming`);
    await button(plan.name).click();
    expect(await edit.getByLabel("Bill entry amount", { exact: true }).inputValue()).toBe("100.01");
    await edit.getByLabel("Bill entry amount", { exact: true }).fill("100.99");
    await edit.getByRole("button", { name: "Review entry", exact: true }).click();
    await review.waitFor();
    await review.getByText("$899.01", { exact: true }).waitFor();
    const before = await snapshot();
    expect(before.transactions ?? []).toEqual([]);
    expect(before.account?.balanceCents).toBe(100000);
    await capture("preview", review);
    await review.getByRole("button", { name: "Confirm record entry", exact: true }).click();
    // A removed host policy lets the posted result appear instead. Money must still be unchanged.
    await guard
      .or(page.getByText("Posted $100.99", { exact: true }))
      .first()
      .waitFor();
    expect(await snapshot()).toEqual(before);
    expect(await guard.isVisible()).toBe(true);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await review
      .getByText("Cancelled. Your captured entry review is kept.", { exact: true })
      .waitFor();
    expect(await snapshot()).toEqual(before);
    await review.getByRole("button", { name: "Confirm record entry", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await page.getByText("Posted $100.99", { exact: true }).waitFor();
    const recorded = await snapshot();
    expect(recorded.account).toMatchObject({ balanceCents: 89901, ledgerRevision: 1 });
    expect(recorded.transactions).toHaveLength(1);
    expect(recorded.transactions![0]).toMatchObject({
      amountCents: 10099,
      categoryId: "utilities",
      source: "manual",
      date: `${month}-01`
    });
    expect(recorded.decisions).toEqual([
      expect.objectContaining({
        state: "matched",
        actualCents: 10099,
        transactionId: recorded.transactions![0]!.id
      })
    ]);
    expect(recorded.revision).toBe(before.revision + 1);
    await page.reload();
    await page.getByText("Posted $100.99", { exact: true }).waitFor();
    // A second due plan must surface the real recorded duplicate and refuse a new entry.
    const duplicate = {
      ...plan,
      id: randomUUID(),
      name: "Synthetic duplicate bill",
      amountCents: 10099
    };
    await owned(async (s) =>
      expect(await s.bills!.create(duplicate, (await s.budgetPolicy!.get())!, at)).toBe(true)
    );
    await page.reload();
    await button(duplicate.name).click();
    await edit.getByRole("button", { name: "Review entry", exact: true }).click();
    await review.getByText(/Review existing expenses first/).waitFor();
    expect(
      await review.getByRole("button", { name: "Confirm record entry", exact: true }).isDisabled()
    ).toBe(true);
    await capture("duplicate", review);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await snapshot()).account).toEqual(recorded.account);
    expect((await snapshot()).transactions).toEqual(recorded.transactions);
    // An independent ledger commit invalidates the captured review before host approval.
    const stale = { ...plan, id: randomUUID(), name: "Synthetic stale bill", amountCents: 5000 };
    await owned(async (s) =>
      expect(await s.bills!.create(stale, (await s.budgetPolicy!.get())!, at)).toBe(true)
    );
    await page.reload();
    await button(stale.name).click();
    await edit.getByRole("button", { name: "Review entry", exact: true }).click();
    await review.waitFor();
    await owned((s) =>
      s.manual!.createEntry({
        id: `manual:${randomUUID()}`,
        accountId,
        name: "Synthetic independent expense",
        date: `${month}-02`,
        amountCents: 123,
        isoCurrency: "USD",
        categoryId: "utilities",
        notes: "",
        cleared: false,
        digest: "f".repeat(64),
        at
      })
    );
    const changed = await snapshot();
    await review.getByRole("button", { name: "Confirm record entry", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.getByText(/The review changed or recording could not be confirmed/).waitFor();
    expect(
      await review.getByRole("button", { name: "Confirm record entry", exact: true }).isDisabled()
    ).toBe(true);
    expect(await snapshot()).toEqual(changed);
    await capture("stale", review);
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Check saved bills", exact: true }).click();
    await page
      .getByText("Saved bills refreshed. Review the current records before saving.", {
        exact: true
      })
      .waitFor();
    await button(stale.name).click();
    await edit.getByRole("button", { name: "Review entry", exact: true }).click();
    await review.getByRole("button", { name: "Confirm record entry", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    await page.getByText("Posted $50.00", { exact: true }).waitFor();
    expect((await snapshot()).account?.balanceCents).toBe(84778);
    expect((await snapshot()).transactions).toHaveLength(3);
    await page.reload();
    await page.getByText("Posted $50.00", { exact: true }).waitFor();
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-bill-entry-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
