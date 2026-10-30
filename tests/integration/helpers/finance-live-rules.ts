import { join, resolve } from "node:path";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import type { Kysely } from "kysely";
import type { BrowserContext } from "playwright-core";
import { expect } from "vitest";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseMerchantRules(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  userId: string,
  month: string,
  read: (name: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const runner = new DataContextRunner(db);
  const withStore = <T>(run: (s: ReturnType<typeof sqlStore>) => Promise<T>) =>
    runner.withDataContext({ actorUserId: userId }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      return run(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  // This owner was genuinely initialized by the real migration worker in the startup flow.
  // Only synthetic statement history is seeded here; no migration marker or rule is inserted.
  expect(await read("finance.rules.list")).toMatchObject({
    supported: true,
    ready: true,
    rules: []
  });
  await withStore(async (s) => {
    await s.putAccount({
      accountId: "synthetic:rule-history",
      itemId: null,
      name: "Synthetic statement history",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: null,
      balanceCents: 10000,
      isoCurrency: "USD",
      updatedAt: `${month}-01T00:00:00Z`
    });
    await s.putTransaction({
      id: "synthetic:rule-history",
      accountId: "synthetic:rule-history",
      date: `${month}-01`,
      amountCents: 1234,
      isoCurrency: "USD",
      name: "SYNTHETIC SHOP #99",
      merchant: null,
      plaidCategory: null,
      categoryId: "groceries",
      pending: false,
      pendingTransactionId: null,
      categorizedBy: "user",
      reviewState: "confirmed",
      notes: "Synthetic private history"
    });
  });
  const history = () => read("finance.transactions.query", { month, ownOnly: true });
  const original = await history(),
    balance = await withStore((s) => s.getAccount("synthetic:rule-history"));
  const rows = async () =>
    (await read("finance.rules.list")).rules as {
      id: string;
      payeeKey: string;
      categoryId: string;
      enabled: boolean;
      writeRevision: string;
    }[];
  const page = await context.newPage();
  try {
    await page.goto(`${base}/m/finance/settings`);
    const section = page.getByRole("region", { name: "Merchant rules", exact: true });
    await section.getByRole("button", { name: "Add merchant rule", exact: true }).click();
    const form = page.getByRole("dialog", { name: "Add merchant rule", exact: true });
    await form.getByLabel("Merchant match", { exact: true }).fill("Synthetic Shop #123");
    await form.getByLabel("Rule category", { exact: true }).selectOption("dining");
    await form.getByLabel("Rule preview month", { exact: true }).fill(month);
    await form.getByRole("button", { name: "Preview matching history", exact: true }).click();
    await form.getByText("Normalized match: synthetic shop", { exact: true }).waitFor();
    await form.getByText("SYNTHETIC SHOP #99", { exact: true }).waitFor();
    expect(await history()).toEqual(original);
    const inspect = async (dialog: ReturnType<typeof page.getByRole>, label: string) => {
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
          const bounds = (await dialog.boundingBox())!;
          for (const control of await dialog
            .locator('input:not([type="checkbox"]),select,button')
            .all()) {
            const box = await control.boundingBox();
            if (box) {
              expect(box.x).toBeGreaterThanOrEqual(bounds.x);
              expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
            }
          }
          const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
          expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
          if (artifacts)
            await page.screenshot({
              path: join(resolve(artifacts), `finance-rule-${label}-${theme}-${width}.png`)
            });
        }
      }
    };
    await inspect(form, "preview");
    await form.getByRole("button", { name: "Review rule", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review merchant rule", exact: true });
    await review.getByText("synthetic shop · Dining & coffee", { exact: true }).waitFor();
    await inspect(review, "review");
    const submit = () => review.getByRole("button", { name: "Confirm rule", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await submit();
    await guard.waitFor();
    expect(await rows()).toEqual([]);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await review
      .getByText("Cancelled. Your captured rule review is kept.", { exact: true })
      .waitFor();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect(await rows()).toMatchObject([
      { payeeKey: "synthetic shop", categoryId: "dining", enabled: true }
    ]);
    expect(await history()).toEqual(original);
    await page.reload();
    const edit = () =>
      section.getByRole("button", { name: "Edit rule for synthetic shop", exact: true }).click();
    const editForm = page.getByRole("dialog", { name: "Edit merchant rule", exact: true });
    const previewAndReview = async () => {
      await editForm.getByRole("button", { name: "Preview matching history", exact: true }).click();
      await editForm.getByText("Normalized match: synthetic shop", { exact: true }).waitFor();
      await editForm.getByRole("button", { name: "Review rule", exact: true }).click();
    };
    const toggleEnabled = async (keyboard = false) => {
      const input = editForm.getByRole("checkbox", { name: "Enable merchant rule", exact: true });
      const before = await input.isChecked();
      if (keyboard) {
        await editForm.getByLabel("Rule category", { exact: true }).focus();
        await page.keyboard.press("Tab");
        expect(await input.evaluate((e) => document.activeElement === e)).toBe(true);
        await page.keyboard.press("Space");
      } else await editForm.getByText("Use this rule for future arrivals", { exact: true }).click();
      expect(await input.isChecked()).toBe(!before);
    };
    await edit();
    expect(await editForm.getByLabel("Merchant match", { exact: true }).isDisabled()).toBe(true);
    await toggleEnabled();
    await previewAndReview();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect((await rows())[0]).toMatchObject({ categoryId: "dining", enabled: false });
    await page.reload();
    await edit();
    await toggleEnabled(true);
    await previewAndReview();
    await withStore(async (s) => {
      const rule = (await s.rules!.all())[0]!;
      expect(
        await s.rules!.apply({
          id: rule.id,
          payeeKey: rule.payeeKey,
          categoryId: "savings",
          enabled: false,
          expectedRevision: rule.writeRevision,
          actor: "user",
          at: `${month}-02T00:00:00Z`
        })
      ).toBe(true);
    });
    const competing = await rows();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review
      .getByText(
        "The rule or category changed. Nothing was saved. Close this review and check saved rules before choosing again.",
        { exact: true }
      )
      .waitFor();
    expect(await rows()).toEqual(competing);
    expect(
      await review.getByRole("button", { name: "Confirm rule", exact: true }).isDisabled()
    ).toBe(true);
    await review.getByRole("button", { name: "Back to rules", exact: true }).click();
    await section.getByRole("button", { name: "Check saved rules", exact: true }).click();
    await edit();
    expect(await editForm.getByLabel("Rule category", { exact: true }).inputValue()).toBe(
      "savings"
    );
    await toggleEnabled();
    await editForm.getByLabel("Rule category", { exact: true }).selectOption("groceries");
    await previewAndReview();
    await submit();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    expect((await rows())[0]).toMatchObject({ categoryId: "groceries", enabled: true });
    const search = section.getByLabel("Search merchant rules", { exact: true });
    await search.fill("Synthetic Shop 123");
    await section.getByRole("button", { name: "Search rules", exact: true }).click();
    await section
      .getByText(
        "1 of 1 rules loaded for “Synthetic Shop 123”. Search matches merchant letters, ignoring digits and punctuation.",
        { exact: true }
      )
      .waitFor();
    await search.fill("No matched merchant");
    await section.getByRole("button", { name: "Search rules", exact: true }).click();
    await section
      .getByText("No rules match this search. Try a merchant name without numbers.", {
        exact: true
      })
      .waitFor();
    await search.fill("");
    await section.getByRole("button", { name: "Search rules", exact: true }).click();
    await section
      .getByRole("button", { name: "Edit rule for synthetic shop", exact: true })
      .waitFor();
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await section.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        const bounds = (await section.boundingBox())!;
        for (const control of await section.locator("input,button").all()) {
          const box = await control.boundingBox();
          if (box) {
            expect(box.x).toBeGreaterThanOrEqual(bounds.x);
            expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
          }
        }
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-rule-list-${theme}-${width}.png`)
          });
      }
    }
    expect(await history()).toEqual(original);
    expect(await withStore((s) => s.getAccount("synthetic:rule-history"))).toEqual(balance);
  } finally {
    await page.close();
  }
}
