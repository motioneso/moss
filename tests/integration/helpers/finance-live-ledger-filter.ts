import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page, Locator } from "playwright-core";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
/** Called before and after the real native statement reconciliation, without reseeding its ledger. */
export async function exerciseLedgerFilter(
  page: Page,
  base: string,
  month: string,
  accountId: string,
  state: "cleared" | "reconciled",
  read: Read,
  artifacts?: string
) {
  const input = { month, accountId, ownOnly: true };
  const before = await read("finance.transactions.query", input);
  const rows = before.transactions as Record<string, unknown>[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ source: "manual", cleared: true, pending: false });
  expect(Boolean(rows[0]!.reconciledAt)).toBe(state === "reconciled");
  const result = await read("finance.transactions.query", { ...input, ledgerState: state });
  expect(result.transactions).toEqual(rows);
  expect(result.totalCount).toBe(1);
  await page.goto(`${base}/m/finance/transactions`);
  const filter = page.getByLabel("Filter by manual ledger status", { exact: true });
  await page.getByRole("button", { name: /^Filters/ }).click();
  await filter.waitFor();
  await page.getByLabel("Filter by account", { exact: true }).selectOption(accountId);
  const chooseFresh = async (value: string, expected: Record<string, unknown>[]) => {
    const [response] = await Promise.all([
      page.waitForResponse(
        (response) =>
          response.url().includes("/assistant-tools/finance.transactions.query/invoke") &&
          response.request().postDataJSON()?.input?.ledgerState === value &&
          response.request().postDataJSON()?.input?.accountId === accountId
      ),
      filter.selectOption(value)
    ]);
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.invocation.result.transactions).toEqual(expected);
    expect(body.invocation.result.totalCount).toBe(expected.length);
  };
  await chooseFresh(state, rows);
  const name = page.getByText("Synthetic manual market", { exact: true }).filter({ visible: true });
  await name.waitFor();
  for (const other of ["uncleared", state === "cleared" ? "reconciled" : "cleared"]) {
    await chooseFresh(other, []);
    await page.getByText("No matches", { exact: true }).waitFor();
  }
  await filter.selectOption(state);
  await name.waitFor();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await filter.isVisible()).toBe(true);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-ledger-${state}-${theme}-${width}.png`),
          fullPage: true
        });
    }
  }
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  expect(await filter.inputValue()).toBe("");
  expect(await page.getByLabel("Filter by account", { exact: true }).inputValue()).toBe("");
  expect(await read("finance.transactions.query", input)).toEqual(before);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${base}/m/finance/accounts`);
}

export async function captureStatementReview(
  page: Page,
  review: Locator,
  finish: Locator,
  artifacts?: string
) {
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
      await finish.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await review.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        false
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-reconcile-${mode}-${width}.png`),
          fullPage: true
        });
    }
  }
}
