import { exerciseSharedTransactionDetails } from "./finance-live-transaction-details.js";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext, Page } from "playwright-core";
import { formatCents, monthLabel } from "../../../external-modules/finance/src/web/format.js";
type Read = (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>;
type Month = {
  month: string;
  byCategory: Record<string, number>;
  byPayee: Record<string, number>;
  cashFlow: { incomeCents: number; outflowCents: number };
};
export async function exerciseReportDetails(
  page: Page,
  context: BrowserContext,
  base: string,
  month: string,
  read: Read,
  foreignRead: Read,
  artifacts?: string
) {
  const report = await read("finance.reports.spending", { months: 6, currency: "USD" });
  const own = (report.own as Month[]).find((r) => r.month === month)!;
  const shared = report.shared as { ownerUserId: string; months: Month[] }[];
  const sharedOwnerIds = shared.map((s) => s.ownerUserId);
  expect(sharedOwnerIds).toHaveLength(1);
  const expected =
    own.byCategory.groceries! +
    shared.reduce(
      (sum, s) => sum + (s.months.find((r) => r.month === month)?.byCategory.groceries ?? 0),
      0
    );
  const input = {
    month,
    currency: "USD",
    group: "category",
    key: "groceries",
    months: 6,
    sharedOwnerIds
  };
  const api = await read("finance.reports.transactions", { ...input, limit: 1 });
  expect(api).toMatchObject({ totalCents: expected, limit: 1 });
  expect(api.totalCount as number).toBeGreaterThan(1);
  expect(api.rows as unknown[]).toHaveLength(1);
  expect(
    (await read("finance.reports.transactions", { ...input, limit: 1, offset: 1 })).totalCents
  ).toBe(expected);
  const all = await read("finance.reports.transactions", { ...input, limit: 200 });
  expect(JSON.stringify(all)).not.toContain("private note");
  expect(JSON.stringify(all)).not.toContain("Synthetic member private purchase");
  expect((all.rows as { id: string }[]).some((r) => r.id === "report:pending")).toBe(true);
  expect((all.rows as { id: string }[]).some((r) => r.id === "report:shared")).toBe(true);
  const foreign = await foreignRead("finance.reports.transactions", {
    ...input,
    sharedOwnerIds: []
  });
  expect(JSON.stringify(foreign)).not.toContain("Synthetic weekend market");
  await page.goto(`${base}/m/finance/reports`);
  await page.getByLabel("Report currency", { exact: true }).selectOption("USD");
  const category = page.getByRole("region", { name: "Spending by category", exact: true });
  const open = category.getByRole("button", { name: "View Groceries transactions", exact: true });
  await open.waitFor();
  await context.setOffline(true);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Report transactions", exact: true });
  const reloadDetails = async () => {
    const reload = dialog.getByRole("button", { name: "Reload details", exact: true });
    const request = async () =>
      (
        await Promise.all([
          page.waitForResponse((r) =>
            r.url().includes("/assistant-tools/finance.reports.transactions/invoke")
          ),
          reload.click()
        ])
      )[0];
    let response = await request();
    if (response.status() === 429) {
      const seconds = Number(await response.headerValue("retry-after"));
      expect(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
      await dialog
        .getByRole("alert")
        .filter({ hasText: `Wait ${seconds} second` })
        .waitFor();
      await expect.poll(() => reload.isDisabled()).toBe(true);
      await page.waitForTimeout(seconds * 1000 + 100);
      response = await request();
    }
    expect(response.status()).toBe(200);
  };
  await dialog.getByRole("alert").waitFor();
  await context.setOffline(false);
  await reloadDetails();
  await dialog
    .getByText(`Current detail total: ${formatCents(expected, "USD")}`, { exact: true })
    .waitFor();
  await dialog.getByText("Synthetic weekend market", { exact: true }).waitFor();
  await dialog.getByText("Whole transaction: $82.43 out", { exact: true }).waitFor();
  await dialog.getByText("Household · read only", { exact: true }).waitFor();
  await dialog.getByText("Pending", { exact: true }).waitFor();
  for (const theme of ["light", "dark", "sage"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-report-detail-${theme}-${width}.png`),
          fullPage: false
        });
    }
  }
  const edit = await context.newPage();
  try {
    const [loaded] = await Promise.all([
      edit.waitForResponse((response) =>
        response.url().includes("/assistant-tools/finance.transactions.query/invoke")
      ),
      edit.goto(`${base}/m/finance/transactions`)
    ]);
    if (loaded.status() === 429) {
      const seconds = Number(await loaded.headerValue("retry-after"));
      expect(Number.isFinite(seconds) && seconds >= 1 && seconds <= 60).toBe(true);
      await edit.getByRole("button", { name: "Retry register", exact: true }).waitFor();
      await edit.waitForTimeout(seconds * 1000 + 100);
      const [retried] = await Promise.all([
        edit.waitForResponse((response) =>
          response.url().includes("/assistant-tools/finance.transactions.query/invoke")
        ),
        edit.getByRole("button", { name: "Retry register", exact: true }).click()
      ]);
      expect(retried.status()).toBe(200);
    } else expect(loaded.status()).toBe(200);
    await exerciseSharedTransactionDetails(edit);
    await edit
      .getByRole("checkbox", { name: "Select Synthetic manual market", exact: true })
      .filter({ visible: true })
      .check();
    await edit
      .getByLabel("Category for selected transactions", { exact: true })
      .selectOption("dining");
    await edit.getByRole("button", { name: "Review category change", exact: true }).click();
    await edit
      .getByRole("dialog", { name: "Review selected transactions", exact: true })
      .getByRole("button", { name: "Confirm category change", exact: true })
      .click();
    await edit
      .getByRole("dialog", { name: "Confirm Finance action", exact: true })
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    await edit
      .getByRole("dialog", { name: "Review selected transactions", exact: true })
      .waitFor({ state: "detached" });
  } catch (error) {
    if (artifacts)
      await edit.screenshot({
        path: join(resolve(artifacts), "finance-report-edit-debug.png"),
        fullPage: true
      });
    throw new Error(
      `Report competing register: ${(await edit.locator("body").innerText()).slice(-2500)}`,
      {
        cause: error
      }
    );
  } finally {
    await edit.close();
  }
  await reloadDetails();
  await dialog
    .getByText(`Current detail total: ${formatCents(expected - 123, "USD")}`, { exact: true })
    .waitFor();
  await dialog
    .getByText(
      "The records changed since this report was shown. The detail total reflects this read; reload Reports to update its totals.",
      { exact: true }
    )
    .waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .getByRole("region", { name: "Spending by payee", exact: true })
    .getByRole("button", { name: "View Synthetic weekend market transactions", exact: true })
    .click();
  await dialog.getByText("Current detail total: $82.43", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const cash = page.getByRole("region", { name: "Cash flow", exact: true });
  await cash.getByRole("group", { name: "Cash flow by month", exact: true }).waitFor();
  await cash.getByRole("button", { name: "Monthly numbers", exact: true }).click();
  await cash
    .getByRole("button", { name: `View income for ${monthLabel(month)}`, exact: true })
    .filter({ visible: true })
    .click();
  await dialog.getByText("Current detail total: $100.00", { exact: true }).waitFor();
  await dialog.getByText("Synthetic report income", { exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const outflow =
    own.cashFlow.outflowCents +
    shared.reduce(
      (sum, s) => sum + (s.months.find((r) => r.month === month)?.cashFlow.outflowCents ?? 0),
      0
    );
  await cash
    .getByRole("button", { name: `View outflow for ${monthLabel(month)}`, exact: true })
    .filter({ visible: true })
    .click();
  await dialog
    .getByText(`Current detail total: ${formatCents(outflow, "USD")}`, { exact: true })
    .waitFor();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => scrollTo(0, 0));
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false
    );
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-reports-${width}.png`),
        fullPage: true
      });
  }
}
