import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import type { BrowserContext } from "playwright-core";
import type { Kysely } from "kysely";
import { DataContextRunner, createModuleStorageRpc, type MossDatabase } from "@moss/db";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
import { waitForFinanceAction } from "./finance-live-ready.js";
export async function exercisePrivateNotes(
  context: BrowserContext,
  base: string,
  month: string,
  db: Kysely<MossDatabase>,
  actorUserId: string,
  artifacts?: string
) {
  const runner = new DataContextRunner(db),
    accountId = `manual:note-${randomUUID()}`,
    transactionId = randomUUID(),
    name = "Synthetic editable private note",
    at = `${month}-01T00:00:00Z`;
  const owned = <T>(fn: (s: ReturnType<typeof sqlStore>) => Promise<T>) =>
    runner.withDataContext({ actorUserId }, (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      return fn(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  const target = { transactionId, accountId, month };
  await owned(async (s) => {
    if (!(await s.budgetPolicy!.get())) await s.budgetPolicy!.configure("USD", false, at);
    expect(
      await s.manual!.createAccount({
        accountId,
        name: "Synthetic note checking",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: `${month}-01`,
        openingBalanceCents: 100000,
        digest: "1".repeat(64),
        at
      })
    ).toBe("created");
    expect(
      await s.manual!.createEntry({
        id: transactionId,
        accountId,
        date: `${month}-01`,
        name,
        amountCents: 1234,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "Original synthetic note",
        cleared: true,
        digest: "2".repeat(64),
        at
      })
    ).toBe("created");
  });
  const snapshot = () =>
    owned(async (s) => ({
      account: await s.getAccount(accountId),
      rows: await s.getTransactionChunk(accountId, month),
      note: await s.notes!.read(target)
    }));
  const page = await context.newPage(),
    details = page.getByRole("dialog", { name: "Transaction details", exact: true }),
    editor = page.getByRole("dialog", { name: "Edit private note", exact: true }),
    guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
  const open = () =>
    page
      .getByRole("button", { name: `View transaction details for ${name}`, exact: true })
      .filter({ visible: true });
  const field = () =>
    editor.getByRole("textbox", { name: "Edit private transaction note", exact: true });
  const start = async () => {
    await open().click();
    await details.getByRole("button", { name: "Edit private note", exact: true }).click();
    await waitForFinanceAction(page, field(), "Check saved note");
    await expect.poll(() => field().isEnabled()).toBe(true);
  };
  const save = async () => {
    await editor.getByRole("button", { name: "Save private note", exact: true }).click();
  };
  const approve = async () => {
    await save();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
  };
  const capture = async (state: string) => {
    for (const [theme, width] of [
      ["light", 1440],
      ["dark", 320]
    ] as const) {
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false
      );
      expect(await editor.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(false);
      const foot = (await editor.locator(".jds-dialog__foot").boundingBox())!;
      expect(foot.y + foot.height).toBeLessThanOrEqual(900);
      if (state === "stale" || state === "uncertain") {
        const status = (await editor.getByRole("status").boundingBox())!;
        expect(status.y).toBeGreaterThanOrEqual(0);
        expect(status.y + status.height).toBeLessThan(foot.y);
        const check = (await editor
          .getByRole("button", { name: "Check saved note", exact: true })
          .boundingBox())!;
        expect(check.y).toBeGreaterThanOrEqual(foot.y);
        expect(check.y + check.height).toBeLessThanOrEqual(900);
      }
      if (state === "recovered") {
        const current = (await editor
          .getByRole("textbox", { name: "Currently saved private note", exact: true })
          .boundingBox())!;
        expect(current.y).toBeGreaterThanOrEqual(0);
        expect(current.y + current.height).toBeLessThan(foot.y);
      }
      if (artifacts)
        await page.screenshot({
          path: join(resolve(artifacts), `finance-private-note-${state}-${theme}-${width}.png`)
        });
    }
  };
  try {
    await page.goto(`${base}/m/finance/transactions`);
    await waitForFinanceAction(page, open(), "Check saved records");
    await start();
    expect(await field().inputValue()).toBe("Original synthetic note");
    const tooLong = "🦉".repeat(1001);
    await field().fill(tooLong);
    expect(await field().inputValue()).toBe(tooLong);
    expect(
      await editor.getByRole("button", { name: "Save private note", exact: true }).isDisabled()
    ).toBe(true);
    await editor.getByRole("alert").waitFor();
    await field().fill("x".repeat(4001));
    expect(await field().inputValue()).toHaveLength(4001);
    expect(
      await editor.getByRole("button", { name: "Save private note", exact: true }).isDisabled()
    ).toBe(true);
    const draft = "  Synthetic café 🦉\nReceipt context stays private.  ";
    await field().fill(draft);
    await capture("edit");
    const before = await snapshot();
    await save();
    await guard
      .or(page.getByText("Private note saved.", { exact: true }))
      .first()
      .waitFor();
    expect(await snapshot()).toEqual(before);
    expect(await guard.isVisible()).toBe(true);
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await editor
      .getByText("Cancelled. Your private note draft is kept.", { exact: true })
      .waitFor();
    expect(await field().inputValue()).toBe(draft);
    expect(await snapshot()).toEqual(before);
    await approve();
    await editor.waitFor({ state: "detached" });
    const after = await snapshot();
    expect(after.note!.notes).toBe(draft);
    expect(after.account).toEqual(before.account);
    expect(after.rows!.map((r) => ({ ...r, notes: undefined }))).toEqual(
      before.rows!.map((r) => ({ ...r, notes: undefined }))
    );
    await expect.poll(() => open().evaluate((e) => document.activeElement === e)).toBe(true);
    await page.reload();
    await waitForFinanceAction(page, open(), "Check saved records");
    await start();
    expect(await field().inputValue()).toBe(draft);
    await field().fill("");
    await approve();
    await editor.waitFor({ state: "detached" });
    expect((await snapshot()).note!.notes).toBe("");
    await start();
    await field().fill("Retained synthetic draft");
    await owned(async (s) => {
      const r = (await s.notes!.read(target))!;
      expect(await s.notes!.save(target, r.writeRevision, "Other saved synthetic note", at)).toBe(
        "saved"
      );
    });
    await approve();
    await editor
      .getByText(
        "The transaction changed or saving could not be confirmed. Your draft is kept. Check the saved note before trying again.",
        { exact: true }
      )
      .waitFor();
    expect(
      await editor.getByRole("button", { name: "Save private note", exact: true }).count()
    ).toBe(0);
    await capture("stale");
    await editor.getByRole("button", { name: "Check saved note", exact: true }).click();
    await waitForFinanceAction(
      page,
      editor.getByRole("textbox", { name: "Currently saved private note", exact: true }),
      "Check saved note"
    );
    expect(await field().inputValue()).toBe("Retained synthetic draft");
    expect(
      await editor
        .getByRole("textbox", { name: "Currently saved private note", exact: true })
        .inputValue()
    ).toBe("Other saved synthetic note");
    await capture("recovered");
    await approve();
    await editor.waitFor({ state: "detached" });
    expect((await snapshot()).note!.notes).toBe("Retained synthetic draft");
    const search = page.getByRole("textbox", { name: "Search payees or notes", exact: true });
    await search.fill("Retained synthetic draft");
    await page.getByText("1 of 1 matching transactions loaded", { exact: false }).waitFor();
    await start();
    const uncertainDraft = "Committed before synthetic response loss";
    await field().fill(uncertainDraft);
    const writeUrl = /\/api\/modules\/finance\/tools\/finance\.transaction\.note-save\/invoke$/;
    let confirmedRequests = 0;
    await page.route(writeUrl, async (route) => {
      const body = route.request().postDataJSON() as { confirmationId?: string };
      if (!body.confirmationId) {
        await route.continue();
        return;
      }
      confirmedRequests++;
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      // The actual approved SQL commit and audit have completed. Lose only its response.
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic response lost after commit" })
      });
    });
    await approve();
    await page
      .getByRole("dialog", { name: "Check this change", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await editor
      .getByRole("status")
      .filter({ hasText: /saving could not be confirmed/i })
      .waitFor();
    await page.unroute(writeUrl);
    expect(confirmedRequests).toBe(1);
    expect(await field().inputValue()).toBe(uncertainDraft);
    expect(
      await editor.getByRole("button", { name: "Save private note", exact: true }).count()
    ).toBe(0);
    const committed = await snapshot();
    expect(committed.note!.notes).toBe(uncertainDraft);
    await capture("uncertain");
    await editor.getByRole("button", { name: "Check saved note", exact: true }).click();
    await waitForFinanceAction(
      page,
      editor.getByRole("textbox", { name: "Currently saved private note", exact: true }),
      "Check saved note"
    );
    expect(
      await editor
        .getByRole("textbox", { name: "Currently saved private note", exact: true })
        .inputValue()
    ).toBe(uncertainDraft);
    expect(
      await editor.getByRole("button", { name: "Save private note", exact: true }).isDisabled()
    ).toBe(true);
    expect(await snapshot()).toEqual(committed);
    await editor
      .getByText("Your draft is already saved. No further change is needed.", { exact: true })
      .waitFor();
    await page.getByText("No matches", { exact: true }).waitFor();
    expect(await editor.isVisible()).toBe(true);
    expect(await field().inputValue()).toBe(uncertainDraft);
    await editor.getByRole("button", { name: "Close private note editor", exact: true }).click();
    await expect.poll(() => search.evaluate((e) => document.activeElement === e)).toBe(true);
    await search.fill("");
    await waitForFinanceAction(page, open(), "Check saved records");
    await open().click();
    expect(
      await details
        .getByRole("textbox", { name: "Private transaction note", exact: true })
        .inputValue()
    ).toBe(uncertainDraft);
    await details.getByRole("button", { name: "Back to register", exact: true }).click();
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-private-note-debug.png"),
        fullPage: true
      });
    throw error;
  } finally {
    await page.close();
  }
}
