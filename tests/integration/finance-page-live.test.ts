import { exercisePrivateNotes } from "./helpers/finance-live-notes.js";
import { exerciseBillEntry } from "./helpers/finance-live-bill-entry.js";
import { exerciseInstalledSplit } from "./helpers/finance-live-splits.js";
import { exerciseCardReserves } from "./helpers/finance-live-cards.js";
import {
  exerciseLedgerFilter,
  captureStatementReview
} from "./helpers/finance-live-ledger-filter.js";
import { configureFinanceProofFixture } from "./helpers/finance-live-negative-fixtures.js";
import { exercisePlanning } from "./helpers/finance-live-planning.js";
import { exerciseTargetFunding } from "./helpers/finance-live-target-funding.js";
import { exerciseMerchantRules } from "./helpers/finance-live-rules.js";
import { exerciseFreshFinanceStartup } from "./helpers/finance-live-startup.js";
import { exerciseIndividualMetadata } from "./helpers/finance-live-metadata.js";
import { exerciseManualTransfers } from "./helpers/finance-live-transfers.js";
import { exerciseAccountLifecycle } from "./helpers/finance-live-accounts.js";
import { exerciseCategoryConfirmation } from "./helpers/finance-live-confirm.js";
import { exerciseHistoryExport } from "./helpers/finance-live-export.js";
import { exerciseManualNetWorth } from "./helpers/finance-live-net-worth.js";
import { exerciseFinanceImport } from "./helpers/finance-live-import.js";
import { seedReportDetails } from "./helpers/finance-live-report-data.js";
import { exerciseReportDetails } from "./helpers/finance-live-reports.js";
import { exerciseBulkCategory } from "./helpers/finance-live-bulk.js";
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
import { accountAction, openAddManualAccount } from "./helpers/finance-live-account-menu.js";

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
    let freshApproved: { cookie: string; userId: string };
    let freshOpen: { cookie: string; userId: string };
    let context: BrowserContext;
    let month = new Date().toISOString().slice(0, 7);
    const artifacts = process.env.MOSS_VISUAL_ARTIFACT_DIR;
    const rejectedRequests: {
      tool: string;
      status: number;
      retryAfter: string | null;
      patternRejected: boolean;
    }[] = [];

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
    async function readyOwner(email: string, name: string, approve = true, verb = "skip") {
      const person = await signUp(email, name);
      if (approve)
        expect((await post(`/api/admin/users/${person.userId}/approve`, {})).statusCode).toBe(200);
      expect((await post(`/api/onboarding/${verb}`, {}, person.cookie)).statusCode).toBe(200);
      return person;
    }
    async function signedInContext(cookie: string) {
      const other = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        reducedMotion: "reduce"
      });
      await other.addCookies(
        cookie.split("; ").map((value) => {
          const at = value.indexOf("=");
          return { name: value.slice(0, at), value: value.slice(at + 1), url: base };
        })
      );
      await other.route("**/*", (route) =>
        new URL(route.request().url()).origin === base ? route.continue() : route.abort()
      );
      return other;
    }
    async function registrationRequiresApproval(requiresApproval: boolean) {
      const response = await server.inject({
        method: "PUT",
        url: "/api/admin/registration",
        headers: { cookie: owner.cookie, origin: base },
        payload: { registrationEnabled: true, requiresApproval }
      });
      expect(response.statusCode, response.body).toBe(200);
    }
    async function readTool(
      name: string,
      input: Record<string, unknown> = {},
      cookie = owner.cookie
    ) {
      let response = await post(`/api/ai/assistant-tools/${name}/invoke`, { input }, cookie);
      // This helper invokes read tools only. Honor one bounded server backoff without
      // raising production limits, retrying writes or changing application responses.
      if (response.statusCode === 429) {
        const delay = Number(response.headers["retry-after"]);
        expect(Number.isFinite(delay) && delay > 0 && delay <= 30).toBe(true);
        await new Promise((done) => setTimeout(done, delay * 1000 + 100));
        response = await post(`/api/ai/assistant-tools/${name}/invoke`, { input }, cookie);
      }
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
        await configureFinanceProofFixture(id!, installed);
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
      month = String((await readTool("finance.manual.context")).today).slice(0, 7);
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
      context.on("response", async (response) => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith("/api/ai/assistant-tools/") || response.status() < 400) return;
        const body = await response.text().catch(() => "");
        rejectedRequests.push({
          tool: path.split("/")[4] ?? "unknown",
          status: response.status(),
          retryAfter: response.headers()["retry-after"] ?? null,
          patternRejected: body.includes("Pattern matching failed and was rejected")
        });
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
      if (rejectedRequests.length)
        process.stderr.write(
          `Finance browser request diagnostics (no bodies): ${JSON.stringify(rejectedRequests.slice(-30))}\n`
        );
      await context?.close();
      await browser?.close();
      await server?.close();
      await Promise.allSettled([appDb?.destroy(), workerDb?.destroy()]);
      if (temp) await rm(temp, { recursive: true, force: true });
      vi.unstubAllEnvs();
    });

    it.each(["approved", "open"] as const)(
      "initializes a fresh Finance owner (%s)",
      async (mode) => {
        await exerciseFreshFinanceStartup({
          modulesDir: join(temp, "modules"),
          workerDb,
          browser,
          base,
          artifacts,
          createReadyOwner: async () => {
            if (mode === "open") await registrationRequiresApproval(false);
            try {
              const person = await readyOwner(
                `fresh-${mode}@finance-page.test`,
                `Synthetic ${mode} owner`,
                mode === "approved",
                mode === "approved" ? "skip" : "complete"
              );
              if (mode === "approved") freshApproved = person;
              else freshOpen = person;
              return person;
            } finally {
              if (mode === "open") await registrationRequiresApproval(true);
            }
          },
          read: (name, params, cookie) => readTool(name, params, cookie)
        });
      },
      90_000
    );

    it("manages merchant rules with actual preview confirmation and stale recovery", async () => {
      const other = await signedInContext(freshApproved.cookie);
      try {
        await exerciseMerchantRules(
          other,
          base,
          workerDb,
          freshApproved.userId,
          month,
          (name, input) => readTool(name, input, freshApproved.cookie),
          artifacts
        );
        expect(await readTool("finance.rules.list", {}, freshOpen.cookie)).toMatchObject({
          ready: true,
          rules: [],
          total: 0
        });
      } finally {
        await other.close();
      }
    }, 90_000);

    it("reviews selected target funding through host confirmation and rejects stale second-tab guidance", async () => {
      const other = await signedInContext(freshApproved.cookie);
      try {
        await exerciseTargetFunding(
          other,
          base,
          month,
          (name, input) => readTool(name, input, freshApproved.cookie),
          artifacts
        );
      } finally {
        await other.close();
      }
    }, 120_000);

    it("reviews card-payment reserves through captured confirmation and actual SQL ledger changes", async () => {
      const person = await readyOwner(
        "card-reserve@finance-page.test",
        "Synthetic card reserve owner"
      );
      const other = await signedInContext(person.cookie);
      try {
        await exerciseCardReserves(
          other,
          base,
          workerDb,
          person.userId,
          month,
          (name, input) => readTool(name, input, person.cookie),
          artifacts
        );
      } finally {
        await other.close();
      }
    }, 150_000);

    it("saves a split through the signed-in Finance UI, real API and installed SQL worker", async () => {
      await exerciseInstalledSplit(context, base, month, readTool, member.cookie, artifacts);
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
      const person = await readyOwner("first-budget@finance-page.test", "Synthetic first budget");
      await seedFirstBudget(appDb, person.userId, month);
      const other = await signedInContext(person.cookie);
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

    it(
      "plans matches skips and stops bills through the installed app without changing the ledger",
      () =>
        exercisePlanning(context, base, month, readTool, "bills", artifacts, {
          db: workerDb,
          actorUserId: owner.userId
        }),
      120_000
    );
    it(
      "confirms one funded flexible pool and an exact return to envelopes without changing transactions",
      () =>
        exercisePlanning(context, base, month, readTool, "flex", artifacts, {
          db: workerDb,
          actorUserId: owner.userId
        }),
      180_000
    );

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
        await openAddManualAccount(page);
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
        await accountAction(page, "Synthetic wallet", "Add transaction to Synthetic wallet");
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
          .getByRole("button", { name: "Actions for Synthetic wallet", exact: true })
          .waitFor();
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-manual-accounts-phone.png"),
            fullPage: true
          });
        await accountAction(page, "Synthetic wallet", "Reconcile Synthetic wallet");
        const review = page.getByRole("dialog", { name: "Reconcile a statement", exact: true });
        await review.getByLabel("Statement balance", { exact: true }).fill("122.21");
        const finish = review.getByRole("button", { name: "Finish reconciliation", exact: true });
        expect(await finish.isDisabled()).toBe(true);
        await review.getByRole("button", { name: "Close", exact: true }).click();
        const beforeReconcile = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions as { reconciledAt: string | null }[];
        expect(beforeReconcile[0]?.reconciledAt).toBeNull();
        await exerciseLedgerFilter(
          page,
          base,
          month,
          account.accountId,
          "cleared",
          readTool,
          artifacts
        );
        await accountAction(page, "Synthetic wallet", "Reconcile Synthetic wallet");
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
        await captureStatementReview(page, review, finish, artifacts);
        await finish.click();
        await review.waitFor({ state: "detached" });
        const reconciled = (
          await readTool("finance.transactions.query", { month, accountId: account.accountId })
        ).transactions as { reconciledAt: string | null }[];
        expect(reconciled[0]?.reconciledAt).toBeTruthy();
        await exerciseLedgerFilter(
          page,
          base,
          month,
          account.accountId,
          "reconciled",
          readTool,
          artifacts
        );
        await page.reload();
        await accountAction(page, "Synthetic wallet", "Reconcile Synthetic wallet");
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
      await exerciseFinanceImport(context, base, month, readTool, post, member.cookie, artifacts);
    }, 90_000);

    it("reviews, confirms and rejects stale bulk category edits through installed desktop and phone UI", async () => {
      const page = await context.newPage();
      try {
        await exerciseBulkCategory(page, context, base, month, readTool, artifacts);
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-bulk-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await page.close();
      }
    }, 90_000);

    it("reconciles report drill-through with real split, pending, shared and currency-scoped records", async () => {
      await seedReportDetails(workerDb, owner.userId, member.userId, month);
      const page = await context.newPage();
      try {
        await exerciseReportDetails(
          page,
          context,
          base,
          month,
          readTool,
          (name, input) => readTool(name, input, member.cookie),
          artifacts
        );
      } catch (error) {
        if (artifacts)
          await page.screenshot({
            path: join(resolve(artifacts), "finance-report-debug.png"),
            fullPage: true
          });
        throw error;
      } finally {
        await context.setOffline(false);
        await page.close();
      }
    }, 90_000);

    async function ownedScenario(kind: "accounts" | "transfers" | "metadata") {
      const identities = {
        accounts: ["account-lifecycle", "Synthetic account lifecycle owner"],
        transfers: ["transfers", "Synthetic transfer owner"],
        metadata: ["metadata", "Synthetic metadata owner"]
      } as const;
      const [email, name] = identities[kind];
      const person = await readyOwner(`${email}@finance-page.test`, name);
      const other = await signedInContext(person.cookie);
      const args = [other, base, workerDb, person.userId] as const;
      const read = (name: string, input?: Record<string, unknown>) =>
        readTool(name, input, person.cookie);
      try {
        if (kind === "metadata") await exerciseIndividualMetadata(...args, month, read, artifacts);
        else
          await (kind === "accounts" ? exerciseAccountLifecycle : exerciseManualTransfers)(
            ...args,
            read,
            artifacts
          );
      } finally {
        await other.close();
      }
    }
    it(
      "manages manual accounts with captured confirmation and preserved history",
      () => ownedScenario("accounts"),
      90_000
    );
    it(
      "records linked manual transfers through real confirmation and rejects stale ledger reviews",
      () => ownedScenario("transfers"),
      90_000
    );
    it(
      "reviews individual categories with actual confirmation and rejects changed financial facts",
      () => ownedScenario("metadata"),
      90_000
    );

    it("shows manual ledger net worth without a bank, with source dates and separated currencies", async () => {
      await exerciseManualNetWorth(
        browser,
        base,
        member.cookie,
        (name, input) => readTool(name, input, member.cookie),
        artifacts
      );
    }, 90_000);

    it("prepares and downloads complete owned history with recoverable errors and explicit scope", async () => {
      await exerciseHistoryExport(context, base, readTool, artifacts);
    }, 90_000);

    it("confirms captured categories only after guarded persistence and recovers stale reviews", async () => {
      await exerciseCategoryConfirmation(
        context,
        base,
        workerDb,
        owner.userId,
        month,
        readTool,
        artifacts
      );
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
    it(
      "edits and clears owned private notes with host confirmation and stale recovery",
      () => exercisePrivateNotes(context, base, month, workerDb, owner.userId, artifacts),
      180_000
    );
    it(
      "records a due bill expense with explicit approval and stale duplicate protection",
      () => exerciseBillEntry(context, base, month, workerDb, owner.userId, artifacts),
      180_000
    );
  }
);
