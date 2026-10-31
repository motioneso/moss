import { join, resolve } from "node:path";
import type { Kysely } from "kysely";
import type { MossDatabase } from "@moss/db";
import type { BrowserContext } from "playwright-core";
import { expect } from "vitest";
import {
  providerFeed,
  feedPage,
  handoffPending,
  handoffItem,
  handoffPosted
} from "./finance-provider-feed.js";
/** Mock provider/credential ports feed real committed SQL; native reads and host review are real. */
export async function exercisePendingHandoffReview(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  userId: string,
  month: string,
  read: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const feed = providerFeed(db, userId, {
    page: async (cursor) =>
      cursor === "pending-removed"
        ? feedPage({ added: [{ ...handoffPosted, date: `${month}-01` }] })
        : feedPage({
            removed: [{ transaction_id: handoffPending.id }],
            hasMore: true,
            nextCursor: "pending-removed"
          })
  });
  await feed.seed();
  expect(await feed.run()).toMatchObject({
    status: "ok",
    items: [expect.objectContaining({ status: "connected", pages: 2 })]
  });
  const saved = async () =>
    (
      (await read("finance.transactions.query", { month, ownOnly: true })).transactions as Record<
        string,
        unknown
      >[]
    ).find((row) => row.id === handoffPosted.transaction_id)!;
  const settled = await saved();
  expect(settled).toMatchObject({
    amountCents: 1200,
    categoryId: "groceries",
    notes: handoffPending.notes,
    reviewState: "needs_look",
    categorizedBy: "user",
    pending: false
  });
  const page = await context.newPage();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${base}/m/finance/transactions`);
    const row = page
      .getByRole("row")
      .filter({ hasText: handoffPosted.name })
      .filter({ visible: true });
    await row.getByText("Review needed", { exact: true }).waitFor();
    await row.getByRole("button", { name: "Confirm", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review transaction category", exact: true });
    await review.getByText("Existing category · Groceries", { exact: true }).waitFor();
    await review.getByText("$12.00", { exact: true }).waitFor();
    for (const theme of ["light", "dark", "sage"]) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      for (const width of [320, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        expect(await review.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
        const footer = (await review.locator(".jds-dialog__foot").boundingBox())!;
        expect(footer.y + footer.height).toBeLessThanOrEqual(900);
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), `finance-pending-settlement-${theme}-${width}.png`)
          });
      }
    }
    const confirm = () =>
      review.getByRole("button", { name: "Confirm category", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await confirm();
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await review
      .getByText("Cancelled. Your selection and category are kept.", { exact: true })
      .waitFor();
    expect(await saved()).toEqual(settled);
    await confirm();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await review.waitFor({ state: "detached" });
    const confirmed = await saved();
    expect(confirmed).toEqual({
      ...settled,
      reviewState: "confirmed",
      writeRevision: expect.stringMatching(/^[a-f0-9]{32}$/)
    });
    expect(confirmed.writeRevision).not.toBe(settled.writeRevision);
    expect(await feed.store.providerHandoffs!.load(handoffItem, [handoffPending.id])).toEqual([]);
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-pending-settlement-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
