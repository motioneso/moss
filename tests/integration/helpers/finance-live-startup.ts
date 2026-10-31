import { join, resolve } from "node:path";
import { sql, type Kysely } from "kysely";
import { DataContextRunner, type MossDatabase } from "@moss/db";
import {
  createPgBossClient,
  registerDataContextWorker,
  PLATFORM_MODULE_CONTROL_QUEUE,
  assertModuleControlPayload,
  type ExternalModuleJobPayload,
  type ModuleControlPayload
} from "@moss/jobs";
import {
  ExternalModuleJobReconciler,
  ExternalModuleWorkerRuntime,
  getExternalModuleRegistrations
} from "@moss/module-registry/node";
import { expect } from "vitest";
import type { Browser } from "playwright-core";
import { createExternalModuleJobHandler } from "../../../apps/worker/src/external-module-job-handler.js";
import { createIsModuleEnabled } from "../../../apps/worker/src/worker-module-gate.js";
import { connectionStrings } from "../test-database.js";
import { openAddManualAccount } from "./finance-live-account-menu.js";

type Person = { userId: string; cookie: string };
export async function exerciseFreshFinanceStartup(input: {
  modulesDir: string;
  workerDb: Kysely<MossDatabase>;
  browser: Browser;
  base: string;
  createReadyOwner: () => Promise<Person>;
  read: (
    name: string,
    params: Record<string, unknown>,
    cookie: string
  ) => Promise<Record<string, unknown>>;
  artifacts?: string;
}) {
  const { discoveries, rejected } = getExternalModuleRegistrations({
    modulesDir: input.modulesDir
  });
  expect(rejected).toEqual([]);
  const finance = discoveries.find((module) => module.id === "finance")!;
  expect(finance).toBeDefined();
  const getDiscoveryById = (id: string) => discoveries.find((module) => module.id === id);
  const listActiveUserIds = async (moduleId: string) =>
    (
      await sql<{
        user_id: string;
      }>`SELECT user_id FROM app.list_active_external_module_users(${moduleId})`.execute(
        input.workerDb
      )
    ).rows.map((row) => row.user_id);
  const dataContext = new DataContextRunner(input.workerDb);
  const runtime = new ExternalModuleWorkerRuntime();
  const boss = createPgBossClient(connectionStrings.worker);
  const migrated = new Set<string>();
  const reconciler = new ExternalModuleJobReconciler({
    boss,
    discoveries: () => [finance],
    isModuleEnabled: createIsModuleEnabled({ db: input.workerDb, getDiscoveryById }),
    listActiveUserIds,
    registerWorker: async (module, queue) => {
      // This fixture starts only the migration lane. No bank sync/provider workers run.
      if (queue.name !== "finance.storage-migrate") return;
      await registerDataContextWorker<ExternalModuleJobPayload, unknown>(
        boss,
        queue.name,
        dataContext,
        createExternalModuleJobHandler({
          module,
          queue,
          runtime,
          workerDb: input.workerDb,
          dataContext,
          getDiscoveryById,
          listDiscoveredModuleIds: () => discoveries.map((module) => module.id),
          listActiveUserIds
        }),
        undefined,
        {
          afterCommit: async (_result, job) => {
            migrated.add(job.data.actorUserId);
          }
        }
      );
    }
  });
  let context: Awaited<ReturnType<Browser["newContext"]>> | undefined;
  try {
    await boss.start();
    await reconciler.reconcileModule("finance");
    await boss.work<ModuleControlPayload>(PLATFORM_MODULE_CONTROL_QUEUE, async ([job]) => {
      if (!job) throw new Error("No module control job");
      assertModuleControlPayload(job.data);
      if (job.data.moduleId === "finance" && job.data.action === "reconcile")
        await reconciler.reconcileModule("finance");
    });
    // Completed older migrations may be coalesced; wait for idle work, not new receipts.
    // Drain earlier fixture work before signup. Otherwise an unrelated old control
    // can initialize the new actor and conceal a missing signup/onboarding event.
    await expect
      .poll(
        async () => {
          const result = await sql<{
            n: number;
          }>`SELECT count(*)::int AS n FROM pgboss.job_common WHERE state IN ('created','retry','active') AND (name='finance.storage-migrate' OR (name=${PLATFORM_MODULE_CONTROL_QUEUE} AND data->>'moduleId'='finance'))`.execute(
            input.workerDb
          );
          return result.rows[0]!.n === 0;
        },
        { timeout: 45_000, interval: 250 }
      )
      .toBe(true);
    // No manual migration job, marker or financial record is inserted by this fixture.
    const person = await input.createReadyOwner();
    try {
      await expect
        .poll(() => migrated.has(person.userId), { timeout: 30_000, interval: 250 })
        .toBe(true);
    } catch (cause) {
      const jobs = await sql<{
        state: string;
        output: unknown;
      }>`SELECT state,output FROM pgboss.job_common WHERE name='finance.storage-migrate' AND data->>'actorUserId'=${person.userId}`.execute(
        input.workerDb
      );
      const controls = await sql<{
        state: string;
      }>`SELECT state FROM pgboss.job_common WHERE name=${PLATFORM_MODULE_CONTROL_QUEUE} AND data->>'moduleId'='finance'`.execute(
        input.workerDb
      );
      const reasons = jobs.rows.map((row) => ({
        state: row.state,
        reason:
          /hash-mismatch|not-active|not-enabled|not-discovered|db_query_failed|permission denied|crash|timeout|invalid_record/.exec(
            JSON.stringify(row.output)
          )?.[0] ?? "unclassified"
      }));
      throw new Error(
        `Finance startup did not complete: ${JSON.stringify({ enabled: await createIsModuleEnabled({ db: input.workerDb, getDiscoveryById })("finance"), active: (await listActiveUserIds("finance")).includes(person.userId), jobs: reasons, controls: controls.rows.map((row) => row.state) })}`,
        { cause }
      );
    }
    const read = (name: string, params: Record<string, unknown> = {}) =>
      input.read(name, params, person.cookie);
    const setup = await read("finance.manual.context");
    expect(setup.supported).toBe(true);
    const month = String(setup.today).slice(0, 7);
    const ownAccounts = async () =>
      ((await read("finance.accounts.list")).accounts as { shared?: boolean }[]).filter(
        (account) => !account.shared
      );
    expect(await ownAccounts()).toEqual([]);
    expect(await read("finance.budget.status", { month })).toMatchObject({
      setupRequired: true,
      isoCurrency: null
    });
    context = await input.browser.newContext({
      viewport: { width: 390, height: 900 },
      reducedMotion: "reduce"
    });
    await context.addCookies(
      person.cookie.split("; ").map((cookie) => {
        const at = cookie.indexOf("=");
        return { name: cookie.slice(0, at), value: cookie.slice(at + 1), url: input.base };
      })
    );
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === input.base ? route.continue() : route.abort()
    );
    const page = await context.newPage();
    await page.goto(`${input.base}/m/finance/accounts`);
    await openAddManualAccount(page);
    const account = page.getByRole("dialog", { name: "Add manual account", exact: true });
    await account.getByLabel("Account name", { exact: true }).fill("Synthetic fresh wallet");
    await account.getByLabel("Account type", { exact: true }).selectOption("cash");
    await account.getByLabel("Opening balance", { exact: true }).fill("500.00");
    await account.getByLabel("Opening balance date", { exact: true }).fill(`${month}-01`);
    await account.getByRole("button", { name: "Add account", exact: true }).click();
    await account.waitFor({ state: "detached" });
    expect(await ownAccounts()).toEqual([
      expect.objectContaining({
        name: "Synthetic fresh wallet",
        balanceCents: 50000,
        source: "manual"
      })
    ]);
    await page.goto(`${input.base}/m/finance`);
    await page.getByLabel("Budget currency", { exact: true }).selectOption("USD");
    await page.getByRole("button", { name: "Review currency choice", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "Confirm Finance action", exact: true });
    await confirm.getByRole("button", { name: "Confirm action", exact: true }).click();
    const assigned = page
      .getByLabel("Assigned to Groceries", { exact: true })
      .filter({ visible: true });
    await assigned.fill("250.00");
    await assigned.press("Enter");
    await confirm.getByRole("button", { name: "Confirm action", exact: true }).click();
    await expect.poll(() => assigned.inputValue()).toBe("$250.00");
    expect(await read("finance.budget.status", { month })).toMatchObject({
      setupRequired: false,
      isoCurrency: "USD",
      state: { categories: { groceries: { assignedCents: 25000 } } }
    });
    expect(await ownAccounts()).toEqual([expect.objectContaining({ balanceCents: 50000 })]);
    if (input.artifacts)
      await page.screenshot({
        path: join(resolve(input.artifacts), "finance-fresh-startup-390.png"),
        fullPage: true
      });
    await page.reload();
    await expect
      .poll(() =>
        page
          .getByLabel("Assigned to Groceries", { exact: true })
          .filter({ visible: true })
          .inputValue()
      )
      .toBe("$250.00");
  } finally {
    await context?.close();
    await reconciler.close();
    await boss.stop({ graceful: false });
    await runtime.close();
  }
}
