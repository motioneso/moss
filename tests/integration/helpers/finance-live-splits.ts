import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext } from "playwright-core";
/** Installed split acceptance, extracted to keep the shared browser harness bounded. */
export async function exerciseInstalledSplit(
  context: BrowserContext,
  base: string,
  month: string,
  readTool: (
    name: string,
    input: Record<string, unknown>,
    cookie?: string
  ) => Promise<Record<string, unknown>>,
  memberCookie: string,
  artifacts?: string
) {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/transactions`);
    const opener = page
      .getByRole("button", { name: "Split Synthetic weekend market", exact: true })
      .filter({ visible: true });
    await opener.waitFor({ timeout: 30_000 });
    await opener.click();
    await page.getByLabel("Split category 2", { exact: true }).selectOption("dining");
    await page.getByLabel("Split amount 1", { exact: true }).fill("60.00");
    await page.getByLabel("Split amount 2", { exact: true }).fill("22.43");
    await page.getByRole("button", { name: "Save split", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Split transaction", exact: true })
      .waitFor({ state: "detached", timeout: 30_000 });
    const result = await readTool("finance.transactions.query", {
      month,
      transactionId: "synthetic-market"
    });
    expect(result.transactions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "synthetic-market",
          amountCents: 8243,
          splitRevision: 1,
          splits: [
            { categoryId: "groceries", amountCents: 6000 },
            { categoryId: "dining", amountCents: 2243 }
          ]
        })
      ])
    );
    const memberRows = (await readTool("finance.transactions.query", { month }, memberCookie))
      .transactions as { id: string }[];
    // The member now owns a synthetic zero-net net-worth fixture; the owner's market stays private.
    expect(memberRows.map((row) => row.id).sort()).toEqual([
      "manual:net-worth-expense",
      "manual:net-worth-refund"
    ]);
    await page.reload();
    await page
      .getByRole("button", { name: "Edit split for Synthetic weekend market", exact: true })
      .filter({ visible: true })
      .waitFor();
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-installed-split-desktop.png"),
        fullPage: true
      });
    await page.setViewportSize({ width: 390, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-installed-split-phone.png"),
        fullPage: true
      });
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-installed-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
