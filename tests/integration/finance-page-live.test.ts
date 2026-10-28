// Opt-in live path: built production host, installed bundles, actual auth/API/workers/RLS.
// No application response interception. All identities/records live in the gate's throwaway DB.
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { sql, type Kysely } from "kysely";
import {
  createDatabase,
  createModuleStorageRpc,
  DataContextRunner,
  type MossDatabase
} from "@moss/db";
import { setModuleKvValue } from "@moss/settings";
import { createApiServer } from "../../apps/api/src/server.js";
import { buildExternalModule } from "../../scripts/build-external-module.js";
import { installModule } from "../../scripts/module-install.js";
import { NS, sqlStore, type FinanceDb } from "../../external-modules/finance/src/domain/index.js";
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
      await new DataContextRunner(workerDb).withDataContext(
        { actorUserId: owner.userId },
        async (scope) => {
          await sql`select set_config('app.current_module_id', 'finance', true)`.execute(scope.db);
          const rpc = createModuleStorageRpc(scope, "finance");
          const db: FinanceDb = {
            query: async (text, params) => {
              const result = await rpc.query(text, params);
              return { rows: [...result.rows] } as never;
            }
          };
          const store = sqlStore(db);
          await store.putItem({
            itemId: "synthetic-bank",
            institutionId: null,
            institutionName: "Synthetic bank",
            connectedAt: `${month}-01T00:00:00Z`,
            status: "connected"
          });
          await store.putAccount({
            accountId: "synthetic-cash",
            itemId: "synthetic-bank",
            name: "Synthetic checking",
            officialName: null,
            type: "depository",
            subtype: "checking",
            mask: "0000",
            balanceCents: 100000,
            isoCurrency: "USD",
            updatedAt: `${month}-01T00:00:00Z`
          });
          await store.putTransaction({
            id: "synthetic-market",
            accountId: "synthetic-cash",
            date: `${month}-01`,
            name: "Synthetic weekend market",
            amountCents: 8243,
            isoCurrency: "USD",
            merchant: null,
            plaidCategory: null,
            categoryId: "groceries",
            pending: false,
            pendingTransactionId: null,
            categorizedBy: "user"
          });
          await setModuleKvValue(
            scope,
            {
              moduleId: "finance",
              namespace: NS.meta,
              scope: "user",
              ownerUserId: owner.userId,
              key: "storage:migrated"
            },
            { at: new Date().toISOString() }
          );
        }
      );
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
