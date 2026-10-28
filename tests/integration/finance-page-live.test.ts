// Opt-in live path: built production host, installed bundles, actual auth/API/workers/RLS.
// No application response interception. All identities/records live in the gate's throwaway DB.
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createApiServer } from "../../apps/api/src/server.js";
import { buildExternalModule } from "../../scripts/build-external-module.js";
import { installModule } from "../../scripts/module-install.js";
import { seedFinanceLive, seedFirstBudget } from "./helpers/finance-live-fixtures.js";
import { exerciseBudgetWrites, exerciseFirstBudget } from "./helpers/finance-live-budget.js";
import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

describe.skipIf(process.env.MOSS_FINANCE_LIVE !== "1")(
  "Finance installed browser live path",
  () => {
    let temp: string;
    let base: string;
    let appDb: Kysely<MossDatabase>;
    let workerDb: Kysely<MossDatabase>;
    let server: ReturnType<typeof createApiServer>;
    let browser: Browser;
    let owner: { cookie: string; userId: string };
    let member: { cookie: string; userId: string };
    let context: BrowserContext;
    const month = new Date().toISOString().slice(0, 7);
    const artifacts = process.env.MOSS_VISUAL_ARTIFACT_DIR;

    async function signUp(email: string, name: string) {
      const response = await server.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { origin: base },
        payload: { email, name, password: "Synthetic test passphrase only 2026" }
      });
      expect(response.statusCode, response.body).toBe(200);
      const cookies = response.headers["set-cookie"];
      return {
        userId: response.json().user.id as string,
        cookie: (Array.isArray(cookies) ? cookies : [cookies ?? ""])
          .map((cookie) => cookie.split(";")[0])
          .join("; ")
      };
    }
    async function post(url: string, input: unknown, cookie = owner.cookie) {
      return server.inject({
        method: "POST",
        url,
        headers: { cookie, origin: base },
        payload: input as Record<string, unknown>
      });
    }
    async function readTool(
      name: string,
      input: Record<string, unknown> = {},
      cookie = owner.cookie
    ) {
      const response = await post(`/api/ai/assistant-tools/${name}/invoke`, { input }, cookie);
      expect(response.statusCode, response.body).toBe(200);
      return response.json().invocation.result as Record<string, unknown>;
    }

    beforeAll(async () => {
      expect(existsSync("apps/web/dist/index.html")).toBe(true);
      await resetEmptyFoundationDatabase();
      temp = await mkdtemp(join(tmpdir(), "finance-page-live-"));
      const listener = createTcpServer();
      await new Promise<void>((done) => listener.listen(0, "127.0.0.1", done));
      const address = listener.address();
      if (!address || typeof address === "string") throw new Error("No test port");
      const port = address.port;
      await new Promise<void>((done) => listener.close(() => done()));
      base = `http://127.0.0.1:${port}`;
      vi.stubEnv("JARVIS_AUTH_BASE_URL", base);
      vi.stubEnv("JARVIS_AUTH_TRUSTED_ORIGINS", base);
      const modulesDir = join(temp, "modules");
      for (const [id, source] of [
        ["finance", "external-modules/finance"],
        ["page-tools-proof", "tests/fixtures/page-tools-module"]
      ]) {
        // Build the synthetic module in temp so no generated files pollute its tracked fixture.
        const buildDir = id === "finance" ? source! : join(temp, "probe-source");
        if (id !== "finance") await cp(source!, buildDir, { recursive: true });
        await buildExternalModule(buildDir);
        const installed = join(modulesDir, id!);
        await mkdir(installed, { recursive: true });
        await cp(join(buildDir, "jarvis.module.json"), join(installed, "jarvis.module.json"));
        await cp(join(buildDir, "dist"), join(installed, "dist"), { recursive: true });
      }
      const manifest = JSON.parse(
        await readFile("external-modules/finance/jarvis.module.json", "utf8")
      );
      await installModule({
        moduleId: "finance",
        manifest,
        bootstrapConnectionString: connectionStrings.bootstrap,
        migrationConnectionString: connectionStrings.migration,
        migrationsDirectory: "external-modules/finance/sql"
      });
      appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
      workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
      server = createApiServer({
        appDb,
        workerDb,
        logger: false,
        apiServerConfig: {
          host: "127.0.0.1",
          port,
          mcpServerUrl: `${base}/api/mcp`,
          externalModulesDir: modulesDir
        }
      });
      await server.listen({ host: "127.0.0.1", port });
      owner = await signUp("owner@finance-page.test", "Synthetic owner");
      for (const id of ["finance", "page-tools-proof"]) {
        const enabled = await post(`/api/admin/external-modules/${id}`, { enabled: true });
        expect(enabled.statusCode, enabled.body).toBe(200);
      }
      expect((await post("/api/onboarding/skip", {})).statusCode).toBe(200);
      member = await signUp("member@finance-page.test", "Synthetic member");
      expect((await post(`/api/admin/users/${member.userId}/approve`, {})).statusCode).toBe(200);
      expect((await post("/api/onboarding/skip", {}, member.cookie)).statusCode).toBe(200);
      await seedFinanceLive(workerDb, appDb, owner, member, month);
      if (artifacts) await mkdir(artifacts, { recursive: true });
      browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
        headless: true,
        args: ["--no-sandbox"]
      });
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce"
      });
      await context.addCookies(
        owner.cookie.split("; ").map((cookie) => {
          const at = cookie.indexOf("=");
          return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: base };
        })
      );
      // Only disallow external services. Local application requests/responses run untouched.
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort()
      );
    }, 120_000);

    afterAll(async () => {
      await context?.close();
      await browser?.close();
      await server?.close();
      await Promise.allSettled([appDb?.destroy(), workerDb?.destroy()]);
      if (temp) await rm(temp, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it("saves a split through the signed-in Finance UI, real API and installed SQL worker", async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/m/finance/transactions`);
        const opener = page
          .getByRole("button", { name: "Split Synthetic weekend market", exact: true })
          .filter({ visible: true });
        await opener.waitFor({ timeout: 30_000 });
        await opener.click();
        await page.getByLabel("Split category 2", { exact: true }).selectOption("dining");
        await page.getByLabel("Split amount 1", { exact: true }).fill("60.00");
        await page.getByLabel("Split amount 2", { exact: true }).fill("22.43");
        await page.getByRole("button", { name: "Save split", exact: true }).click();
        await page
          .getByRole("dialog", { name: "Split transaction", exact: true })
          .waitFor({ state: "detached", timeout: 30_000 });
        const result = await readTool("finance.transactions.query", {
          month,
          transactionId: "synthetic-market"
        });
        expect(result.transactions).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "synthetic-market",
              amountCents: 8243,
              splitRevision: 1,
              splits: [
                { categoryId: "groceries", amountCents: 6000 },
                { categoryId: "dining", amountCents: 2243 }
              ]
            })
          ])
        );
        expect(
          (await readTool("finance.transactions.query", { month }, member.cookie)).transactions
        ).toEqual([]);
        await page.reload();
        await page
          .getByRole("button", { name: "Edit split for Synthetic weekend market", exact: true })
          .filter({ visible: true })
          .waitFor();
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-installed-split-desktop.png"),
            fullPage: true
          });
        await page.setViewportSize({ width: 390, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-installed-split-phone.png"),
            fullPage: true
          });
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-installed-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await page.close();
      }
    }, 90_000);

    it("reviews and confirms the working currency through the real host before showing budget amounts", async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/m/finance`);
        await page
          .getByRole("heading", { name: "Give your budget a currency", exact: true })
          .waitFor();
        const choose = page.getByRole("button", { name: "Review currency choice", exact: true });
        expect(await choose.isDisabled()).toBe(true);
        await page.getByLabel("Budget currency", { exact: true }).selectOption("USD");
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-budget-setup-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await choose.click();
        const confirm = page.getByRole("dialog", {
          name: "Confirm Finance action",
          exact: true
        });
        await confirm.waitFor();
        expect(await readTool("finance.budget.status", { month })).toMatchObject({
          setupRequired: true,
          isoCurrency: null
        });
        await confirm.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByText("Cancelled. Your currency choice is kept for review.", { exact: true })
          .waitFor();
        expect(await page.getByLabel("Budget currency", { exact: true }).inputValue()).toBe("USD");
        await choose.click();
        await confirm.getByRole("button", { name: "Confirm action", exact: true }).click();
        await page
          .getByLabel("Assigned to Groceries", { exact: true })
          .filter({ visible: true })
          .waitFor();
        expect(await readTool("finance.budget.status", { month })).toMatchObject({
          setupRequired: false,
          isoCurrency: "USD"
        });
        expect(await readTool("finance.budget.status", { month }, member.cookie)).toMatchObject({
          setupRequired: true,
          isoCurrency: null
        });
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-budget-currency-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await exerciseBudgetWrites(page, readTool, month, artifacts);
      } finally {
        await page.close();
      }
    }, 90_000);

    it("builds and starts a reviewed budget from manual history without a bank", async () => {
      const person = await signUp("first-budget@finance-page.test", "Synthetic first budget");
      expect((await post(`/api/admin/users/${person.userId}/approve`, {})).statusCode).toBe(200);
      expect((await post("/api/onboarding/skip", {}, person.cookie)).statusCode).toBe(200);
      await seedFirstBudget(appDb, person.userId, month);
      const other = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce"
      });
      await other.addCookies(
        person.cookie.split("; ").map((cookie) => {
          const at = cookie.indexOf("=");
          return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: base };
        })
      );
      await other.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort()
      );
      const page = await other.newPage();
      try {
        await exerciseFirstBudget(
          page,
          base,
          (name, input) => readTool(name, input, person.cookie),
          month,
          artifacts
        );
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-first-budget-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await other.close();
      }
    }, 90_000);

    it("reviews unchanged legacy amounts in EUR and excludes the other currency in the actual page", async () => {
      const other = await browser.newContext({
        viewport: { width: 390, height: 900 },
        reducedMotion: "reduce"
      });
      await other.addCookies(
        member.cookie.split("; ").map((cookie) => {
          const at = cookie.indexOf("=");
          return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: base };
        })
      );
      await other.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort()
      );
      const page = await other.newPage();
      try {
        await page.goto(`${base}/m/finance`);
        await page.getByLabel("Budget currency", { exact: true }).selectOption("EUR");
        const review = page.getByRole("button", { name: "Review currency choice", exact: true });
        expect(await review.isDisabled()).toBe(true);
        await page
          .getByRole("region", { name: "Existing monthly assignments" })
          .getByText("20.00", { exact: true })
          .waitFor();
        await page
          .getByText("Interpret my existing assignment amounts as EUR", { exact: true })
          .click();
        expect(await review.isEnabled()).toBe(true);
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-budget-legacy-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await review.click();
        await page
          .getByRole("dialog", { name: "Confirm Finance action", exact: true })
          .getByRole("button", { name: "Confirm action", exact: true })
          .click();
        await page
          .getByLabel("Assigned to Groceries", { exact: true })
          .filter({ visible: true })
          .waitFor();
        expect(await readTool("finance.budget.status", { month }, member.cookie)).toMatchObject({
          isoCurrency: "EUR",
          readyToAssignCents: 121450,
          excludedAccountCount: 1,
          state: { categories: { groceries: { assignedCents: 2000 } } }
        });
        expect(
          await page
            .getByLabel("Assigned to Groceries", { exact: true })
            .filter({ visible: true })
            .inputValue()
        ).toBe("€20.00");
        await page.getByText("€1,214.50", { exact: true }).waitFor();
        expect(await readTool("finance.budget.status", { month })).toMatchObject({
          isoCurrency: "USD"
        });
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-budget-eur-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
      } finally {
        await other.close();
      }
    }, 90_000);

    it("creates a manual account and a cleared transaction through the installed Finance page", async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/m/finance/accounts`);
        await page.getByRole("button", { name: "Add manual account", exact: true }).click();
        const accountDialog = page.getByRole("dialog", { name: "Add manual account", exact: true });
        await accountDialog.getByLabel("Account name", { exact: true }).fill("Synthetic wallet");
        await accountDialog.getByLabel("Account type", { exact: true }).selectOption("cash");
        await accountDialog.getByLabel("Opening balance", { exact: true }).fill("123.45");
        await accountDialog.getByLabel("Opening balance date", { exact: true }).fill(`${month}-01`);
        await accountDialog.getByRole("button", { name: "Add account", exact: true }).click();
        await accountDialog.waitFor({ state: "detached" });
        const accountResult = await readTool("finance.accounts.list");
        const rows = accountResult.accounts as Array<{
          accountId: string;
          name: string;
          source?: string;
          balanceCents: number;
        }>;
        const account = rows.find((row) => row.name === "Synthetic wallet")!;
        expect(account).toMatchObject({ source: "manual", balanceCents: 12345 });
        await page
          .getByRole("button", { name: "Add transaction to Synthetic wallet", exact: true })
          .click();
        const entryDialog = page.getByRole("dialog", { name: "Add transaction", exact: true });
        await entryDialog.getByLabel("Payee", { exact: true }).fill("Synthetic manual market");
        await entryDialog.getByLabel("Transaction amount", { exact: true }).fill("1.234");
        expect(
          await entryDialog
            .getByRole("button", { name: "Save transaction", exact: true })
            .isDisabled()
        ).toBe(true);
        await entryDialog.getByLabel("Transaction amount", { exact: true }).fill("1.23");
        await entryDialog
          .getByLabel("Transaction category", { exact: true })
          .selectOption("groceries");
        await entryDialog
          .getByLabel("Private note", { exact: true })
          .fill("Synthetic owner-only note");
        await entryDialog.getByText("Cleared on your statement", { exact: true }).click();
        expect(
          await entryDialog.getByLabel("Cleared on your statement", { exact: true }).isChecked()
        ).toBe(true);
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            await entryDialog
              .getByRole("button", { name: "Save transaction", exact: true })
              .scrollIntoViewIfNeeded();
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-manual-entry-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "light";
        });
        await page.setViewportSize({ width: 390, height: 900 });
        expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
          false
        );
        await entryDialog.getByRole("button", { name: "Save transaction", exact: true }).click();
        await entryDialog.waitFor({ state: "detached" });
        const saved = (await readTool("finance.accounts.list")).accounts as typeof rows;
        expect(saved.find((row) => row.accountId === account.accountId)?.balanceCents).toBe(12222);
        const records = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions;
        expect(records).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              name: "Synthetic manual market",
              amountCents: 123,
              notes: "Synthetic owner-only note",
              source: "manual",
              cleared: true
            })
          ])
        );
        expect(
          (
            await readTool(
              "finance.transactions.query",
              { month, accountId: account.accountId },
              member.cookie
            )
          ).transactions
        ).toEqual([]);
        await page.reload();
        await page
          .getByRole("button", { name: "Add transaction to Synthetic wallet", exact: true })
          .waitFor();
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-manual-accounts-phone.png"),
            fullPage: true
          });
        await page.getByRole("button", { name: "Reconcile Synthetic wallet", exact: true }).click();
        const review = page.getByRole("dialog", { name: "Reconcile a statement", exact: true });
        await review.getByLabel("Statement balance", { exact: true }).fill("122.21");
        const finish = review.getByRole("button", { name: "Finish reconciliation", exact: true });
        expect(await finish.isDisabled()).toBe(true);
        await review.getByRole("button", { name: "Close", exact: true }).click();
        const beforeReconcile = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions as { reconciledAt: string | null }[];
        expect(beforeReconcile[0]?.reconciledAt).toBeNull();
        await page.getByRole("button", { name: "Reconcile Synthetic wallet", exact: true }).click();
        await review.getByLabel("Statement balance", { exact: true }).fill("122.22");
        expect(await finish.isEnabled()).toBe(true);
        const selection = review.getByRole("checkbox", {
          name: /^Cleared: Synthetic manual market/
        });
        await selection.focus();
        await page.keyboard.press("Space");
        expect(await finish.isDisabled()).toBe(true);
        await selection.locator("..").click();
        expect(await finish.isEnabled()).toBe(true);
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            await finish.scrollIntoViewIfNeeded();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            expect(
              await review.evaluate((element) => element.scrollWidth > element.clientWidth)
            ).toBe(false);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-reconcile-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await finish.click();
        await review.waitFor({ state: "detached" });
        const reconciled = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions as { reconciledAt: string | null }[];
        expect(reconciled[0]?.reconciledAt).toBeTruthy();
        await page.reload();
        await page.getByRole("button", { name: "Reconcile Synthetic wallet", exact: true }).click();
        await review.getByText(/Last reconciled statement:/).waitFor();
        expect(await finish.isDisabled()).toBe(true);
        const foreign = await post(
          "/api/modules/finance/tools/finance.reconciliation.read/invoke",
          { input: { accountId: account.accountId } },
          member.cookie
        );
        expect(foreign.statusCode).toBe(422);
        expect(foreign.body).not.toContain("Synthetic wallet");
        await review.getByRole("button", { name: "Close", exact: true }).click();
        const budget = await readTool("finance.budget.status", { month });
        expect(budget.readyToAssignCents).toBe(120588);
        await page.goto(`${base}/m/finance`);
        await page.getByText("$1,205.88", { exact: true }).waitFor();
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-manual-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await page.close();
      }
    }, 90_000);

    it("maps, reviews and imports a CSV with explicit duplicate decisions through the installed page", async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/m/finance/accounts`);
        await page.getByRole("button", { name: "Add manual account", exact: true }).click();
        const create = page.getByRole("dialog", { name: "Add manual account", exact: true });
        await create.getByLabel("Account name", { exact: true }).fill("Synthetic import wallet");
        await create.getByLabel("Opening balance", { exact: true }).fill("1000.00");
        await create.getByLabel("Opening balance date", { exact: true }).fill(`${month}-01`);
        await create.getByRole("button", { name: "Add account", exact: true }).click();
        await create.waitFor({ state: "detached" });
        await page
          .getByRole("button", { name: "Import CSV into Synthetic import wallet", exact: true })
          .click();
        const dialog = page.getByRole("dialog", { name: "Import CSV", exact: true });
        const csv = `Date,Payee,Amount,Notes\r\n${month}-02,"Synthetic, market",1.23,"Synthetic import note"\r\n${month}-02,"Synthetic, market",1.23,\r\n${month}-03,Synthetic refund,-4.56,\r\n`;
        await dialog
          .getByLabel("CSV file", { exact: true })
          .setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
        const preview = dialog.getByRole("button", { name: "Preview import", exact: true });
        expect(await preview.isDisabled()).toBe(true);
        await dialog.getByLabel("Date column", { exact: true }).selectOption("0");
        await dialog.getByLabel("Payee column", { exact: true }).selectOption("1");
        await dialog.getByLabel("Amount column", { exact: true }).selectOption("2");
        await dialog.getByLabel("Note column", { exact: true }).selectOption("3");
        await dialog.getByLabel("Date format", { exact: true }).selectOption("iso");
        await dialog.getByLabel("Amount meaning", { exact: true }).selectOption("positive-out");
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            await preview.scrollIntoViewIfNeeded();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            expect(
              await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)
            ).toBe(false);
            const heading = await dialog.locator(".jds-dialog__head").boundingBox();
            const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
            expect(heading!.y).toBeGreaterThanOrEqual(0);
            expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-import-map-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await preview.click();
        await dialog.getByText(/2 decisions remaining/).waitFor();
        expect(
          await dialog
            .getByRole("button", { name: "Import 3 transactions", exact: true })
            .isDisabled()
        ).toBe(true);
        await dialog
          .getByLabel("Duplicate decision for row 1", { exact: true })
          .selectOption("import");
        await dialog
          .getByLabel("Duplicate decision for row 2", { exact: true })
          .selectOption("skip");
        await dialog.getByText("Imported entries are cleared", { exact: true }).click();
        const apply = dialog.getByRole("button", { name: "Import 2 transactions", exact: true });
        expect(await apply.isEnabled()).toBe(true);
        for (const mode of ["light", "dark"]) {
          await page.evaluate((mode) => {
            document.documentElement.dataset.theme = mode;
          }, mode);
          for (const width of [320, 390, 768, 1440]) {
            await page.setViewportSize({ width, height: 900 });
            await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
            await apply.scrollIntoViewIfNeeded();
            expect(
              await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
            ).toBe(false);
            expect(
              await dialog.evaluate((element) => element.scrollWidth > element.clientWidth)
            ).toBe(false);
            const heading = await dialog.locator(".jds-dialog__head").boundingBox();
            const footer = await dialog.locator(".jds-dialog__foot").boundingBox();
            expect(heading!.y).toBeGreaterThanOrEqual(0);
            expect(footer!.y + footer!.height).toBeLessThanOrEqual(900);
            if (artifacts)
              await page.screenshot({
                path: join(resolve(artifacts), `finance-import-review-${mode}-${width}.png`),
                fullPage: true
              });
          }
        }
        await apply.click();
        await dialog.waitFor({ state: "detached" });
        await page.reload();
        await page
          .getByRole("button", { name: "Import CSV into Synthetic import wallet", exact: true })
          .waitFor();
        const accounts = (await readTool("finance.accounts.list")).accounts as {
          accountId: string;
          name: string;
          balanceCents: number;
        }[];
        const account = accounts.find((row) => row.name === "Synthetic import wallet")!;
        expect(account.balanceCents).toBe(100333);
        const transactions = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions as { id: string; amountCents: number; cleared: boolean }[];
        expect(transactions).toHaveLength(2);
        expect(transactions.map((row) => row.amountCents).sort((a, b) => a - b)).toEqual([
          -456, 123
        ]);
        expect(transactions.every((row) => row.cleared)).toBe(true);
        expect(transactions.map((row) => row.id.split(":").at(-1)).sort()).toEqual(["1", "3"]);
        const foreign = await post(
          "/api/modules/finance/tools/finance.import.preview/invoke",
          {
            input: {
              accountId: account.accountId,
              isoCurrency: "USD",
              rows: [
                {
                  sourceRow: 1,
                  date: `${month}-02`,
                  name: "Synthetic",
                  amountCents: 1,
                  notes: "",
                  allowDuplicate: false
                }
              ]
            }
          },
          member.cookie
        );
        expect(foreign.statusCode).toBe(422);
        expect(foreign.body).not.toContain("Synthetic import wallet");
        await page
          .getByRole("button", { name: "Import CSV into Synthetic import wallet", exact: true })
          .click();
        await dialog
          .getByLabel("CSV file", { exact: true })
          .setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(csv) });
        await dialog.getByLabel("Date column", { exact: true }).selectOption("0");
        await dialog.getByLabel("Payee column", { exact: true }).selectOption("1");
        await dialog.getByLabel("Amount column", { exact: true }).selectOption("2");
        await dialog.getByLabel("Date format", { exact: true }).selectOption("iso");
        await dialog.getByLabel("Amount meaning", { exact: true }).selectOption("positive-out");
        await preview.click();
        await dialog.getByText(/3 decisions remaining/).waitFor();
        await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
        expect(
          (await readTool("finance.transactions.query", { month, accountId: account.accountId }))
            .transactions
        ).toHaveLength(2);
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-import-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await page.close();
      }
    }, 90_000);

    it("confirms and cancels real worker deletion through the actual host dialog", async () => {
      const page = await context.newPage();
      try {
        await page.goto(`${base}/m/page-tools-proof`);
        await page.getByRole("checkbox", { name: "Pack the synthetic tent", exact: true }).click();
        await page
          .getByRole("status")
          .filter({ hasText: /^succeeded$/ })
          .waitFor();
        expect(
          await page
            .getByRole("checkbox", { name: "Pack the synthetic tent", exact: true })
            .isChecked()
        ).toBe(true);
        expect(await readTool("page-tools-proof.read")).toEqual({ exists: true, delivered: false });
        expect(await readTool("page-tools-proof.read", {}, member.cookie)).toEqual({
          exists: false,
          delivered: false
        });
        const remove = page.getByRole("button", { name: "Delete synthetic entry", exact: true });
        await remove.click();
        const dialog = page.getByRole("dialog", { name: "Confirm Page tools proof action" });
        await dialog.waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({ exists: true, delivered: false });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("status")
          .filter({ hasText: /^cancelled$/ })
          .waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({ exists: true, delivered: false });
        await remove.click();
        await dialog.waitFor();
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "platform-installed-confirmation.png"),
            fullPage: true
          });
        await page.getByRole("button", { name: "Confirm action", exact: true }).click();
        await page
          .getByRole("status")
          .filter({ hasText: /^succeeded$/ })
          .waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({
          exists: false,
          delivered: false
        });
        const send = page.getByRole("button", { name: "Send to synthetic recipient", exact: true });
        await send.click();
        await dialog.waitFor();
        await page
          .getByText("This action sends information outside Moss.", { exact: false })
          .waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({
          exists: false,
          delivered: false
        });
        await page.getByRole("button", { name: "Cancel", exact: true }).click();
        await page
          .getByRole("status")
          .filter({ hasText: /^cancelled$/ })
          .waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({
          exists: false,
          delivered: false
        });
        await send.click();
        await dialog.waitFor();
        await page.getByRole("button", { name: "Confirm action", exact: true }).click();
        await page
          .getByRole("status")
          .filter({ hasText: /^succeeded$/ })
          .waitFor();
        expect(await readTool("page-tools-proof.read")).toEqual({ exists: false, delivered: true });
        const rows = await new DataContextRunner(appDb).withDataContext(
          { actorUserId: owner.userId },
          (scope) =>
            scope.db
              .selectFrom("app.moss_action_audit_log")
              .select(["tool_name", "outcome", "approval_mode"])
              .where("source_surface", "=", "module_page")
              .execute()
        );
        expect(rows).toEqual(
          expect.arrayContaining([
            { tool_name: "finance.transaction.split", outcome: "success", approval_mode: "auto" },
            { tool_name: "page-tools-proof.save", outcome: "success", approval_mode: "auto" },
            {
              tool_name: "page-tools-proof.delete",
              outcome: "success",
              approval_mode: "confirmed"
            },
            { tool_name: "page-tools-proof.send", outcome: "success", approval_mode: "confirmed" }
          ])
        );
        expect(rows.filter((row) => row.tool_name === "page-tools-proof.delete")).toHaveLength(1);
        expect(rows.filter((row) => row.tool_name === "page-tools-proof.send")).toHaveLength(1);
        await page.goto(`${base}/settings?section=activity`);
        const activity = page
          .getByRole("button", { name: "Split a transaction into categories", exact: true })
          .first();
        await activity.click();
        await page
          .getByRole("dialog")
          .getByText(/Module page/)
          .waitFor();
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "platform-installed-activity.png"),
            fullPage: true
          });
      } finally {
        await page.close();
      }
    }, 90_000);
  }
);
