import { join, resolve } from "node:path";
import type { Page } from "playwright-core";
import { expect } from "vitest";
import { shiftMonth, shortDayLabel } from "../../../external-modules/finance/src/web/format.js";
export async function exerciseBillAdjustments(
  page: Page,
  base: string,
  month: string,
  planId: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const range = (m: string) => ({ from: `${m}-01`, to: `${m}-28` });
  const bills = (m: string) => read("finance.bills.read", range(m));
  const accounts = await read("finance.accounts.list", {});
  const next = shiftMonth(month, 1);
  const stepMonth = (target: Page, direction: "previous" | "next") =>
    target.locator(".jds-stepper button")[direction === "next" ? "last" : "first"]().click();
  const inspect = async (target: ReturnType<typeof page.getByRole>, name: string) => {
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        expect(await target.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
        const bounds = (await target.boundingBox())!;
        for (const control of await target.locator("input,select,button").all()) {
          const box = await control.boundingBox();
          if (box) {
            expect(box.x).toBeGreaterThanOrEqual(bounds.x);
            expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          }
        }
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-bill-change-${name}-${theme}-${width}.png`),
            fullPage: name === "list"
          });
      }
    }
  };
  const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  // Row buttons are named with the bill and the day it lands on.
  const billName = ((await bills(month)).plans as { id: string; name: string }[]).find(
    (p) => p.id === planId
  )!.name;
  const rowButton = (scope: Pick<Page, "getByRole">, label: string, date: string) =>
    scope.getByRole("button", {
      name: `${label}, ${billName}, ${shortDayLabel(date)}`,
      exact: true
    });
  await rowButton(page, "Change this occurrence", `${month}-01`).click();
  const edit = page.getByRole("dialog", { name: "Change this occurrence", exact: true });
  await edit.getByLabel("Occurrence planned date", { exact: true }).fill(`${next}-03`);
  await edit.getByLabel("Occurrence expected amount", { exact: true }).fill("81.99");
  await inspect(edit, "editor");
  await edit.getByRole("button", { name: "Review bill change", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Review bill change", exact: true });
  await inspect(review, "review");
  await review.getByRole("button", { name: "Confirm bill change", exact: true }).click();
  await guard.waitFor();
  expect((await bills(month)).occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        planId,
        dueDate: `${month}-01`,
        plannedDate: `${month}-01`,
        expectedCents: 8200
      })
    ])
  );
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  await review
    .getByText("Cancelled. Your captured bill change is kept.", { exact: true })
    .waitFor();
  await review.getByRole("button", { name: "Confirm bill change", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.waitFor({ state: "detached" });
  expect((await bills(month)).occurrences).toEqual([]);
  await page.reload();
  await page.getByText(/^Nothing due in /).waitFor();
  await stepMonth(page, "next");
  const changed = page.locator(".jds-index__row").filter({ hasText: "one-off change from" });
  await changed.waitFor();
  expect((await bills(next)).occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        dueDate: `${month}-01`,
        plannedDate: `${next}-03`,
        expectedCents: 8199
      }),
      expect.objectContaining({
        dueDate: `${next}-01`,
        plannedDate: `${next}-01`,
        expectedCents: 8200
      })
    ])
  );
  await inspect(page.getByRole("region", { name: "Upcoming bills", exact: true }), "list");
  await rowButton(changed, "Change this occurrence", `${next}-03`).click();
  await edit.getByLabel("Occurrence expected amount", { exact: true }).fill("84.01");
  await edit.getByRole("button", { name: "Review bill change", exact: true }).click();
  // A second actual installed page wins; the first retains its captured, stale review.
  const other = await page.context().newPage();
  try {
    await other.goto(`${base}/m/finance/upcoming`);
    await stepMonth(other, "next");
    await rowButton(other, "Reset one-off change", `${next}-03`).click();
    await other
      .getByRole("dialog", { name: "Reset one-off bill change", exact: true })
      .getByRole("button", { name: "Confirm reset", exact: true })
      .click();
    await other
      .getByRole("dialog", { name: "Confirm Finance action", exact: true })
      .getByRole("button", { name: "Confirm action", exact: true })
      .click();
    await other
      .getByRole("dialog", { name: "Reset one-off bill change", exact: true })
      .waitFor({ state: "detached" });
  } finally {
    await other.close();
  }
  await review.getByRole("button", { name: "Confirm bill change", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.getByText(/The review changed or saving could not be confirmed/).waitFor();
  expect(
    await review.getByRole("button", { name: "Confirm bill change", exact: true }).isDisabled()
  ).toBe(true);
  await review.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Check saved bills", exact: true }).click();
  await page
    .getByText("Saved bills refreshed. Review the current records before saving.", { exact: true })
    .waitFor();
  await stepMonth(page, "previous");
  await rowButton(page, "Change this occurrence", `${month}-01`).click();
  await edit.getByLabel("Occurrence expected amount", { exact: true }).fill("81.99");
  await edit.getByRole("button", { name: "Review bill change", exact: true }).click();
  await review.getByRole("button", { name: "Confirm bill change", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await review.waitFor({ state: "detached" });
  await rowButton(page, "Reset one-off change", `${month}-01`).click();
  const reset = page.getByRole("dialog", { name: "Reset one-off bill change", exact: true });
  await reset.getByRole("button", { name: "Confirm reset", exact: true }).click();
  await guard.getByRole("button", { name: "Cancel", exact: true }).click();
  expect((await bills(month)).occurrences).toEqual(
    expect.arrayContaining([expect.objectContaining({ expectedCents: 8199, adjusted: true })])
  );
  await reset.getByRole("button", { name: "Confirm reset", exact: true }).click();
  await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  await reset.waitFor({ state: "detached" });
  await page.reload();
  await rowButton(page, "Change this occurrence", `${month}-01`).waitFor();
  expect((await bills(month)).occurrences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        dueDate: `${month}-01`,
        plannedDate: `${month}-01`,
        expectedCents: 8200,
        adjusted: false
      })
    ])
  );
  expect(await read("finance.accounts.list", {})).toEqual(accounts);
}
