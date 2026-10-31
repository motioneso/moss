import { join, resolve } from "node:path";
import type { Page, Response } from "playwright-core";
import type { Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import { expect } from "vitest";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseLegacyTargetRepair(
  page: Page,
  db: Kysely<MossDatabase>,
  actorUserId: string,
  month: string,
  read: (name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  let retryAt = 0;
  const observe = async (response: Response) => {
    if (
      response.status() !== 429 ||
      !response.url().includes("/assistant-tools/finance.budget.status/invoke")
    )
      return;
    const seconds = Number(await response.headerValue("retry-after"));
    if (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60)
      retryAt = Date.now() + seconds * 1000;
  };
  page.on("response", observe);
  await page
    .getByLabel("Assigned to Flexible spending", { exact: true })
    .filter({ visible: true })
    .waitFor();
  const before = await read("finance.budget.status", { month });
  expect(before.flex).toMatchObject({
    active: true,
    flexIds: expect.arrayContaining(["groceries"])
  });
  const accounts = await read("finance.accounts.list", {}),
    transactions = await read("finance.transactions.query", { month });
  // Explicit synthetic legacy fixture, not a claim that a valid new mode switch creates this state.
  await new DataContextRunner(db).withDataContext({ actorUserId }, async (scope) => {
    const rpc = createModuleStorageRpc(scope, "finance");
    const store = sqlStore({
      query: async (text, params) => ({
        rows: [...(await rpc.query(text, params)).rows] as never[]
      })
    });
    expect(
      await store.targets!.save(
        {
          categoryId: "groceries",
          effectiveMonth: month,
          kind: "monthly",
          amountCents: 1234,
          dueDate: null
        },
        (await store.budgetPolicy!.get())!,
        `${month}-02T00:00:00Z`
      )
    ).toBe(true);
  });
  await page.reload();
  const region = page.getByRole("region", { name: "Category targets", exact: true });
  const row = region.locator(".jds-index__row").filter({ hasText: "Groceries" });
  await row.getByRole("button", { name: "Review old target", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Review old target", exact: true });
  expect(await dialog.getByLabel("Target category", { exact: true }).inputValue()).toBe(
    "groceries"
  );
  expect(await dialog.getByRole("option", { name: "Flexible spending", exact: true }).count()).toBe(
    0
  );
  expect(await dialog.getByLabel("Target amount", { exact: true }).isDisabled()).toBe(true);
  expect(await dialog.getByRole("button", { name: "Save target", exact: true }).isDisabled()).toBe(
    true
  );
  for (const [theme, width] of [
    ["dark", 320],
    ["light", 1440]
  ] as const) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 900 });
    expect(await dialog.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
    const foot = (await dialog.locator(".jds-dialog__foot").boundingBox())!;
    expect(foot.y + foot.height).toBeLessThanOrEqual(900);
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), `finance-legacy-target-${theme}-${width}.png`)
      });
  }
  await dialog.getByRole("button", { name: "Remove target", exact: true }).click();
  await dialog.waitFor({ state: "detached" });
  await region
    .getByRole("button", { name: "Review old target", exact: true })
    .waitFor({ state: "detached" });
  const after = await read("finance.budget.status", { month });
  expect(after.targets).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ categoryId: "groceries" })])
  );
  expect((after.state as { categories: unknown }).categories).toEqual(
    (before.state as { categories: unknown }).categories
  );
  expect(await read("finance.accounts.list", {})).toEqual(accounts);
  expect(await read("finance.transactions.query", { month })).toEqual(transactions);
  // A successful metadata save may be followed by a busy read; reproduce the user's explicit recovery.
  if (retryAt || (await page.getByText(/Finance is temporarily busy/).isVisible())) {
    await page.waitForTimeout(Math.max(0, retryAt - Date.now()) + 100);
    await page.getByRole("button", { name: "Check saved records", exact: true }).click();
    await page
      .getByLabel("Assigned to Flexible spending", { exact: true })
      .filter({ visible: true })
      .waitFor();
  }
  page.off("response", observe);
}
