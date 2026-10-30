import { billMatchWindow } from "../../../external-modules/finance/src/domain/recurrence.js";
import { exerciseBillAdjustments } from "./finance-live-bill-adjustments.js";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";
export async function exerciseBills(
  page: Page,
  base: string,
  month: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const previousDate = new Date(`${month}-01T00:00:00Z`);
  previousDate.setUTCDate(0);
  const previousMonth = previousDate.toISOString().slice(0, 7);
  const previousBefore = await read("finance.transactions.query", { month: previousMonth });
  const transactionsBefore = await read("finance.transactions.query", { month });
  await page.goto(`${base}/m/finance/upcoming`);
  await page.getByRole("heading", { name: "Know what's coming", exact: true }).waitFor();
  await page.getByRole("button", { name: "Add a bill", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a bill", exact: true });
  await dialog.getByLabel("Bill name", { exact: true }).fill("Synthetic market plan");
  await dialog.getByLabel("Bill account", { exact: true }).selectOption("synthetic-cash");
  await dialog.getByLabel("Bill category", { exact: true }).selectOption("groceries");
  await dialog.getByLabel("Expected bill amount", { exact: true }).fill("82.00");
  await dialog.getByLabel("First planned date", { exact: true }).fill(`${month}-01`);
  for (const mode of ["light", "dark"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const heading = await dialog.locator(".jds-dialog__head").boundingBox();
      const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
      expect(heading!.y).toBeGreaterThanOrEqual(0);
      expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
      for (const button of await dialog.getByRole("button").all()) {
        const box = await button.boundingBox();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
      }
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-bill-editor-${mode}-${width}.png`),
          fullPage: false
        });
    }
  }
  await dialog.getByRole("button", { name: "Save bill plan", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  const view = await read("finance.bills.read", { from: `${month}-01`, to: `${month}-28` });
  const plan = (view.plans as { id: string; name: string }[]).find(
    (p) => p.name === "Synthetic market plan"
  )!;
  expect(plan).toBeTruthy();
  expect(view.occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ planId: plan.id, state: "projected", expectedCents: 8200 })
    ])
  );
  await exerciseBillAdjustments(page, base, month, plan.id, read, artifacts);
  await page.getByRole("button", { name: "Match posted", exact: true }).click();
  const match = page.getByRole("dialog", { name: "Match a posted transaction", exact: true });
  await match.getByLabel("Posted transaction", { exact: true }).selectOption("synthetic-market");
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const window = billMatchWindow(`${month}-01`, `${month}-${last}`);
  await match
    .getByText(
      `Posted expenses from ${window.from} through ${window.to}, including seven days either side of this month. Previously matched transactions are excluded.`,
      { exact: true }
    )
    .waitFor();
  const selectedOption = await match
    .getByLabel("Posted transaction", { exact: true })
    .locator("option:checked")
    .textContent();
  expect(selectedOption).toContain(previousDate.toISOString().slice(0, 10));
  for (const [theme, width] of [
    ["light", 1440],
    ["dark", 320]
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    expect(await match.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
    const footer = await match.locator(".jds-dialog__foot").boundingBox();
    expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-bill-match-${theme}-${width}.png`)
      });
  }
  await match.getByRole("button", { name: "Save match", exact: true }).click();
  await match.waitFor({ state: "detached" });
  await page.getByText("Posted $82.43", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("Posted $82.43", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Undo review", exact: true }).click();
  await page.getByRole("button", { name: "Skip occurrence", exact: true }).waitFor();
  await page.getByRole("button", { name: "Skip occurrence", exact: true }).click();
  await page.getByText("Skipped", { exact: true }).waitFor();
  for (const mode of ["light", "dark", "sage"]) {
    await page.evaluate((mode) => {
      document.documentElement.dataset.theme = mode;
    }, mode);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-upcoming-${mode}-${width}.png`),
          fullPage: true
        });
    }
  }
  await page.getByRole("button", { name: "Stop future bills", exact: true }).click();
  const stop = page.getByRole("dialog", { name: "Stop future bills", exact: true });
  await stop.getByLabel("Last planned date", { exact: true }).fill(`${month}-01`);
  await stop.getByRole("button", { name: "Save last planned date", exact: true }).click();
  await stop.waitFor({ state: "detached" });
  await page.getByText("Stopped", { exact: true }).waitFor();
  expect(
    (await read("finance.bills.read", { from: `${month}-01`, to: `${month}-28` })).occurrences
  ).toEqual(expect.arrayContaining([expect.objectContaining({ state: "skipped" })]));
  expect(await read("finance.transactions.query", { month })).toEqual(transactionsBefore);
  expect(await read("finance.transactions.query", { month: previousMonth })).toEqual(
    previousBefore
  );
}
