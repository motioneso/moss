import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext } from "playwright-core";
import { parseCsv } from "../../../external-modules/finance/src/domain/csv-import.js";
export async function exerciseHistoryExport(
  context: BrowserContext,
  base: string,
  read: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const prepared = await read("finance.transactions.export");
  expect(prepared.status).toBe("ready");
  expect(Number(prepared.totalCount)).toBeGreaterThan(0);
  expect(prepared.csv).not.toContain("Synthetic member private purchase");
  expect(prepared.csv).not.toContain("private note");
  const page = await context.newPage();
  let downloads = 0;
  page.on("download", () => downloads++);
  try {
    await page.goto(`${base}/m/finance/transactions`);
    await page.getByRole("button", { name: "Export history", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Export transaction history", exact: true });
    await dialog.getByRole("button", { name: "Prepare CSV", exact: true }).click();
    await dialog
      .getByRole("status")
      .filter({ hasText: new RegExp(`^${prepared.totalCount} transactions ready`) })
      .waitFor();
    expect(downloads).toBe(0);
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
            path: join(resolve(artifacts), `finance-history-export-${theme}-${width}.png`),
            fullPage: true
          });
      }
    }
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Download CSV", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("moss-transactions-history-start-latest.csv");
    const path = await download.path();
    expect(path).not.toBeNull();
    const csv = await readFile(path!, "utf8");
    expect(csv).toBe(`\uFEFF${prepared.csv}`);
    const parsed = parseCsv(csv);
    expect(parsed.rows).toHaveLength(Number(prepared.totalCount));
    expect(parsed.headers).not.toContain("Notes");
    await dialog.getByLabel("From date (inclusive)", { exact: true }).fill("1900-01-02");
    expect(await dialog.getByRole("button", { name: "Download CSV", exact: true }).count()).toBe(0);
    await dialog.getByLabel("Through date (inclusive)", { exact: true }).fill("1900-01-01");
    await dialog.getByRole("button", { name: "Prepare CSV", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "start on or before the end" }).waitFor();
    await dialog.getByLabel("From date (inclusive)", { exact: true }).fill("1900-01-01");
    await context.setOffline(true);
    await dialog.getByRole("button", { name: "Prepare CSV", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Your choices are kept" }).waitFor();
    expect(await dialog.getByLabel("From date (inclusive)", { exact: true }).inputValue()).toBe(
      "1900-01-01"
    );
    expect(await dialog.getByRole("button", { name: "Download CSV", exact: true }).count()).toBe(0);
    await context.setOffline(false);
    await dialog.getByRole("button", { name: "Prepare CSV", exact: true }).click();
    await dialog.getByRole("status").filter({ hasText: "0 transactions ready" }).waitFor();
    await dialog.getByText("The CSV contains column headings only.", { exact: false }).waitFor();
    await dialog.getByRole("button", { name: "Close", exact: true }).focus();
    await dialog.getByRole("button", { name: "Close", exact: true }).press("Enter");
    await page.reload();
    await page.getByRole("button", { name: "Export history", exact: true }).click();
    expect(await dialog.getByLabel("From date (inclusive)", { exact: true }).inputValue()).toBe("");
    expect(await dialog.getByRole("button", { name: "Download CSV", exact: true }).count()).toBe(0);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-history-export-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await context.setOffline(false);
    await page.close();
  }
}
