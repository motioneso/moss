import { join, resolve } from "node:path";
import { expect } from "vitest";
import { sql, type Kysely } from "kysely";
import { createModuleStorageRpc, DataContextRunner, type MossDatabase } from "@moss/db";
import type { BrowserContext } from "playwright-core";
import { sqlStore } from "../../../external-modules/finance/src/domain/index.js";
export async function exerciseAccountLifecycle(
  context: BrowserContext,
  base: string,
  db: Kysely<MossDatabase>,
  userId: string,
  read: (name: string, input?: Record<string, unknown>) => Promise<Record<string, unknown>>,
  artifacts?: string
) {
  const owner = <T>(run: (store: ReturnType<typeof sqlStore>) => Promise<T>) =>
    new DataContextRunner(db).withDataContext({ actorUserId: userId }, async (scope) => {
      await sql`select set_config('app.current_module_id','finance',true)`.execute(scope.db);
      const rpc = createModuleStorageRpc(scope, "finance");
      return run(
        sqlStore({
          query: async (text, params) => ({
            rows: [...(await rpc.query(text, params)).rows] as never[]
          })
        })
      );
    });
  const today = String((await read("finance.manual.context")).today);
  const id = "manual:lifecycle-live";
  await owner(async (s) => {
    expect(
      await s.manual!.createAccount({
        accountId: id,
        name: "Synthetic lifecycle cash",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: today,
        openingBalanceCents: 0,
        digest: "a".repeat(64),
        at: new Date().toISOString()
      })
    ).toBe("created");
  });
  await owner(async (s) => {
    expect(
      await s.manual!.createAccount({
        accountId: "manual:lifecycle-nonzero",
        name: "Synthetic balance to resolve",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: today,
        openingBalanceCents: 10000,
        digest: "b".repeat(64),
        at: new Date().toISOString()
      })
    ).toBe("created");
  });
  const saved = async () =>
    (await read("finance.manual.account-review", { accountId: id })).account as {
      name: string;
      archivedAt: string | null;
      revision: string;
    };
  const page = await context.newPage();
  const failedReads: { status: number; retryAfter: number | null; patternRejected: boolean }[] = [];
  page.on("response", async (response) => {
    if (
      !response.url().includes("/finance.manual.account-review/invoke") ||
      response.status() < 400
    )
      return;
    const body = await response.text().catch(() => "");
    failedReads.push({
      status: response.status(),
      retryAfter: Number(response.headers()["retry-after"]) || null,
      patternRejected: body.includes("Pattern matching failed and was rejected")
    });
  });

  try {
    await page.goto(`${base}/m/finance/accounts`);
    await page
      .getByRole("button", { name: "Manage Synthetic lifecycle cash", exact: true })
      .click();
    const manager = page.getByRole("dialog", { name: "Manage manual account", exact: true });
    await manager.getByRole("button", { name: "Rename account", exact: true }).click();
    await manager.getByLabel("Account name", { exact: true }).fill("Synthetic renamed cash");
    await manager.getByRole("button", { name: "Save account name", exact: true }).click();
    const guard = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await guard.waitFor();
    await guard.getByRole("button", { name: "Cancel", exact: true }).click();
    await manager
      .getByText("Cancelled. Your account review and draft are kept.", { exact: true })
      .waitFor();
    expect((await saved()).name).toBe("Synthetic lifecycle cash");
    expect(await manager.getByLabel("Account name", { exact: true }).inputValue()).toBe(
      "Synthetic renamed cash"
    );
    await manager.getByRole("button", { name: "Save account name", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await manager.waitFor({ state: "detached" });
    expect((await saved()).name).toBe("Synthetic renamed cash");
    await page.getByRole("button", { name: "Manage Synthetic renamed cash", exact: true }).click();
    await manager.getByRole("button", { name: "Review closing", exact: true }).click();
    await manager.getByText("The saved ledger is ready to close.", { exact: true }).waitFor();
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
            path: join(resolve(artifacts), `finance-account-close-${theme}-${width}.png`),
            fullPage: true
          });
      }
    }
    await manager.getByRole("button", { name: "Close in Moss", exact: true }).click();
    await guard.waitFor();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await manager.waitFor({ state: "detached" });
    expect((await saved()).archivedAt).not.toBeNull();
    expect(
      await page
        .getByRole("button", { name: "Add transaction to Synthetic renamed cash", exact: true })
        .count()
    ).toBe(0);
    await page.getByRole("button", { name: /Closed accounts \(/ }).click();
    await page.getByRole("button", { name: "Manage Synthetic renamed cash", exact: true }).click();
    await manager.getByRole("button", { name: "Review reopening", exact: true }).click();
    await manager.getByRole("button", { name: "Reopen manual account", exact: true }).click();
    await guard.waitFor();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await manager.waitFor({ state: "detached" });
    expect((await saved()).archivedAt).toBeNull();
    await page.getByRole("button", { name: "Manage Synthetic renamed cash", exact: true }).click();
    await manager.getByRole("button", { name: "Rename account", exact: true }).click();
    await manager.getByLabel("Account name", { exact: true }).fill("Synthetic retained draft");
    await owner(async (s) => {
      const review = await s.accountLifecycle!.review(id, today);
      expect(
        await s.accountLifecycle!.update({
          accountId: id,
          expectedRevision: review!.revision,
          operation: "rename",
          name: "Synthetic other tab",
          today,
          at: new Date().toISOString()
        })
      ).toBe(true);
    });
    await manager.getByRole("button", { name: "Save account name", exact: true }).click();
    await guard.getByRole("button", { name: "Confirm action", exact: true }).click();
    await manager
      .getByText(
        "This account or its dependencies changed. No account update was saved. Review its saved state before trying again.",
        { exact: true }
      )
      .waitFor();
    expect((await saved()).name).toBe("Synthetic other tab");
    expect(
      await manager.getByRole("button", { name: "Save account name", exact: true }).isDisabled()
    ).toBe(true);
    await manager.getByRole("button", { name: "Review saved account", exact: true }).click();
    await manager.getByRole("button", { name: "Rename account", exact: true }).click();
    expect(await manager.getByLabel("Account name", { exact: true }).inputValue()).toBe(
      "Synthetic retained draft"
    );
    await manager.getByRole("button", { name: "Back to account", exact: true }).click();
    await manager.getByRole("button", { name: "View account history", exact: true }).click();
    await page.waitForURL(/\/transactions\?/);
    expect(new URL(page.url()).searchParams.get("scope")).toBe("own");
    expect(new URL(page.url()).searchParams.get("accountId")).toBe(id);
    await page.getByRole("button", { name: "Include shared records", exact: true }).waitFor();
  } catch (error) {
    if (artifacts)
      await page.screenshot({
        path: join(resolve(artifacts), "finance-accounts-debug.png"),
        fullPage: true
      });
    throw new Error(`Account lifecycle UI failed; read failures: ${JSON.stringify(failedReads)}`, {
      cause: error
    });
  } finally {
    await page.close();
  }
}
