import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext } from "playwright-core";
import { accountAction, openAddManualAccount } from "./finance-live-account-menu.js";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Post = (
  url: string,
  input: unknown,
  cookie?: string
) => Promise<{ statusCode: number; body: string }>;
export async function exerciseFinanceImport(
  context: BrowserContext,
  base: string,
  month: string,
  readTool: Read,
  post: Post,
  memberCookie: string,
  artifacts?: string
) {
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/accounts`);
    await openAddManualAccount(page);
    const create = page.getByRole("dialog", { name: "Add manual account", exact: true });
    await create.getByLabel("Account name", { exact: true }).fill("Synthetic import wallet");
    await create.getByLabel("Opening balance", { exact: true }).fill("1000.00");
    await create.getByLabel("Opening balance date", { exact: true }).fill(`${month}-01`);
    await create.getByRole("button", { name: "Add account", exact: true }).click();
    await create.waitFor({ state: "detached" });
    await accountAction(page, "Synthetic import wallet", "Import CSV into Synthetic import wallet");
    const dialog = page.getByRole("dialog", { name: "Import CSV", exact: true });
    const csv = `Date,Payee,Amount,Notes\r\n${month}-02,"Synthetic, market",1.23,"Synthetic import note"\r\n${month}-02,"Synthetic, market",1.23,\r\n${month}-03,Synthetic refund,-4.56,\r\n`;
    await dialog
      .getByLabel("CSV file", { exact: true })
      .setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    const preview = dialog.getByRole("button", { name: "Preview import", exact: true });
    expect(await preview.isDisabled()).toBe(true);
    await dialog.getByLabel("Date column", { exact: true }).selectOption("0");
    await dialog.getByLabel("Payee column", { exact: true }).selectOption("1");
    await dialog.getByLabel("Amount column", { exact: true }).selectOption("2");
    await dialog.getByLabel("Note column", { exact: true }).selectOption("3");
    await dialog.getByLabel("Date format", { exact: true }).selectOption("iso");
    await dialog.getByLabel("Amount meaning", { exact: true }).selectOption("positive-out");
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.theme = mode;
      }, mode);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
        await preview.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false
        );
        const heading = await dialog.locator(".jds-dialog__head").boundingBox();
        const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
        expect(heading!.y).toBeGreaterThanOrEqual(0);
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-import-map-${mode}-${width}.png`),
            fullPage: true
          });
      }
    }
    await preview.click();
    await dialog.getByText(/2 decisions remaining/).waitFor();
    expect(
      await dialog.getByRole("button", { name: "Import 3 transactions", exact: true }).isDisabled()
    ).toBe(true);
    await dialog.getByLabel("Duplicate decision for row 1", { exact: true }).selectOption("import");
    await dialog.getByLabel("Duplicate decision for row 2", { exact: true }).selectOption("skip");
    await dialog.getByText("Imported entries are cleared", { exact: true }).click();
    const apply = dialog.getByRole("button", { name: "Import 2 transactions", exact: true });
    expect(await apply.isEnabled()).toBe(true);
    for (const mode of ["light", "dark"]) {
      await page.evaluate((mode) => {
        document.documentElement.dataset.theme = mode;
      }, mode);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
        await apply.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        expect(await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
          false
        );
        const heading = await dialog.locator(".jds-dialog__head").boundingBox();
        const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
        expect(heading!.y).toBeGreaterThanOrEqual(0);
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-import-review-${mode}-${width}.png`),
            fullPage: true
          });
      }
    }
    await apply.click();
    await dialog.waitFor({ state: "detached" });
    await page.reload();
    await page
      .getByRole("button", { name: "Actions for Synthetic import wallet", exact: true })
      .waitFor();
    const accounts = (await readTool("finance.accounts.list")).accounts as {
      accountId: string;
      name: string;
      balanceCents: number;
    }[];
    const account = accounts.find((row) => row.name === "Synthetic import wallet")!;
    expect(account.balanceCents).toBe(100333);
    const transactions = (
      await readTool("finance.transactions.query", { month, accountId: account.accountId })
    ).transactions as { id: string; amountCents: number; cleared: boolean }[];
    expect(transactions).toHaveLength(2);
    expect(transactions.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([-456, 123]);
    expect(transactions.every((row) => row.cleared)).toBe(true);
    expect(transactions.map((row) => row.id.split(":").at(-1)).sort()).toEqual(["1", "3"]);
    const foreign = await post(
      "/api/modules/finance/tools/finance.import.preview/invoke",
      {
        input: {
          accountId: account.accountId,
          isoCurrency: "USD",
          rows: [
            {
              sourceRow: 1,
              date: `${month}-02`,
              name: "Synthetic",
              amountCents: 1,
              notes: "",
              allowDuplicate: false
            }
          ]
        }
      },
      memberCookie
    );
    expect(foreign.statusCode).toBe(422);
    expect(foreign.body).not.toContain("Synthetic import wallet");
    await accountAction(page, "Synthetic import wallet", "Import CSV into Synthetic import wallet");
    await dialog
      .getByLabel("CSV file", { exact: true })
      .setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
    await dialog.getByLabel("Date column", { exact: true }).selectOption("0");
    await dialog.getByLabel("Payee column", { exact: true }).selectOption("1");
    await dialog.getByLabel("Amount column", { exact: true }).selectOption("2");
    await dialog.getByLabel("Date format", { exact: true }).selectOption("iso");
    await dialog.getByLabel("Amount meaning", { exact: true }).selectOption("positive-out");
    await preview.click();
    await dialog.getByText(/3 decisions remaining/).waitFor();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(
      (await readTool("finance.transactions.query", { month, accountId: account.accountId }))
        .transactions
    ).toHaveLength(2);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-import-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
