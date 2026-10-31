import { billMatchWindow } from "../../../external-modules/finance/src/domain/recurrence.js";
import { dayYearLabel, shortDayLabel } from "../../../external-modules/finance/src/web/format.js";
import { exerciseBillAdjustments } from "./finance-live-bill-adjustments.js";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { Page } from "playwright-core";
export async function exerciseBills(
  page: Page,
  base: string,
  month: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string,
  inspectEmpty?: (inspect: () => Promise<void>) => Promise<void>
) {
  const previousDate = new Date(`${month}-01T00:00:00Z`);
  previousDate.setUTCDate(0);
  const previousMonth = previousDate.toISOString().slice(0, 7);
  let previousBefore = await read("finance.transactions.query", { month: previousMonth });
  const transactionsBefore = await read("finance.transactions.query", { month });
  await page.goto(`${base}/m/finance/upcoming`);
  await page.getByText("No bills yet", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Add a bill", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add a bill", exact: true });
  await dialog.getByLabel("Bill name", { exact: true }).fill("Synthetic market plan");
  await dialog.getByLabel("Bill account", { exact: true }).selectOption("synthetic-cash");
  await dialog.getByLabel("Bill category", { exact: true }).selectOption("groceries");
  await dialog.getByLabel("Expected amount (USD)", { exact: true }).fill("82.00");
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
  // Row buttons are named with the bill and the day it lands on.
  const rowButton = (label: string) =>
    page.getByRole("button", {
      name: `${label}, ${plan.name}, ${shortDayLabel(`${month}-01`)}`,
      exact: true
    });
  if (inspectEmpty) {
    await inspectEmpty(async () => {
      await page.reload();
      await rowButton("Match posted").click();
      const empty = page.getByRole("dialog", { name: "Match a posted transaction", exact: true });
      const posted = empty.getByLabel("Posted transaction", { exact: true });
      expect(await posted.locator("option:checked").textContent()).toBe(
        "No posted expenses available"
      );
      expect(await posted.isDisabled()).toBe(true);
      expect(
        await empty.getByRole("button", { name: "Save match", exact: true }).isDisabled()
      ).toBe(true);
      for (const [theme, width] of [
        ["light", 1440],
        ["dark", 320]
      ] as const) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        await page.setViewportSize({ width, height: 900 });
        expect(await empty.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
        const footer = await empty.locator(".jds-dialog__foot").boundingBox();
        expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-bill-match-empty-${theme}-${width}.png`)
          });
      }
      await empty.getByRole("button", { name: "Cancel", exact: true }).click();
      await empty.waitFor({ state: "detached" });
    });
    const restored = await read("finance.transactions.query", { month: previousMonth });
    const beforeRows = previousBefore.transactions as Record<string, unknown>[];
    const restoredRows = restored.transactions as Record<string, unknown>[];
    const fixtureRevision = restoredRows.find(
      (row) => row.id === "synthetic-market"
    )!.writeRevision;
    expect(typeof fixtureRevision).toBe("string");
    expect(fixtureRevision).not.toBe(
      beforeRows.find((row) => row.id === "synthetic-market")!.writeRevision
    );
    // The controlled pending flip must preserve every field except its expected MVCC review token.
    expect(restored).toEqual({
      ...previousBefore,
      transactions: beforeRows.map((row) =>
        row.id === "synthetic-market" ? { ...row, writeRevision: fixtureRevision } : row
      )
    });
    // Keep the full, current response (including the new token) as the baseline for actual matching.
    previousBefore = restored;
    await page.reload();
  }
  await rowButton("Match posted").click();
  const match = page.getByRole("dialog", { name: "Match a posted transaction", exact: true });
  expect(await match.getByLabel("Posted transaction", { exact: true }).inputValue()).toBe("");
  expect(await match.getByRole("button", { name: "Save match", exact: true }).isDisabled()).toBe(
    true
  );
  await match.getByLabel("Posted transaction", { exact: true }).selectOption("synthetic-market");
  const last = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate();
  const window = billMatchWindow(`${month}-01`, `${month}-${last}`);
  const windowFrom = dayYearLabel(window.from, "short");
  const windowTo = dayYearLabel(window.to, "short");
  await match
    .getByText(`Posted expenses from ${windowFrom} through ${windowTo}.`, { exact: true })
    .waitFor();
  const selectedOption = await match
    .getByLabel("Posted transaction", { exact: true })
    .locator("option:checked")
    .textContent();
  expect(selectedOption).toContain(dayYearLabel(previousDate.toISOString().slice(0, 10), "short"));
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
  await rowButton("Undo review").click();
  await rowButton("Skip occurrence").waitFor();
  await rowButton("Skip occurrence").click();
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
  await page
    .getByRole("button", { name: "Actions for Synthetic market plan", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "Stop future bills for Synthetic market plan", exact: true })
    .click();
  const stop = page.getByRole("dialog", { name: "Stop future bills", exact: true });
  await stop.getByLabel("Last planned date", { exact: true }).fill(`${month}-01`);
  await stop.getByRole("button", { name: "Save last planned date", exact: true }).click();
  await stop.waitFor({ state: "detached" });
  await page.getByText(/ · stopped after /).waitFor();
  expect(
    (await read("finance.bills.read", { from: `${month}-01`, to: `${month}-28` })).occurrences
  ).toEqual(expect.arrayContaining([expect.objectContaining({ state: "skipped" })]));
  expect(await read("finance.transactions.query", { month })).toEqual(transactionsBefore);
  expect(await read("finance.transactions.query", { month: previousMonth })).toEqual(
    previousBefore
  );
}
