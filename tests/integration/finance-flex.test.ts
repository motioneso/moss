import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import {
  createDatabase,
  DataContextRunner,
  createModuleStorageRpc,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import type { Kysely } from "kysely";
import { installModule } from "../../scripts/module-install.js";
import { sqlStore, type FinanceDb } from "../../external-modules/finance/src/domain/index.js";
import {
  connectionStrings,
  ids,
  resetFoundationDatabase,
  grantModuleMembershipAtSetup,
  revokeModuleMembershipAtTeardown,
  dropModuleRolesAtTeardown
} from "./test-database.js";
let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
let ownedTables: string[];
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => ({ rows: [...(await rpc.query(text, params)).rows] as never[] })
  };
  return sqlStore(port);
}
const owner = <T>(
  fn: (s: ReturnType<typeof store>) => Promise<T>,
  actorUserId: string = ids.userA
) => runner.withDataContext({ actorUserId }, (scope) => fn(store(scope)));
beforeAll(async () => {
  await resetFoundationDatabase();
  const manifest = JSON.parse(
    await readFile("external-modules/finance/jarvis.module.json", "utf8")
  );
  ownedTables = manifest.database.ownedTables;
  await installModule({
    moduleId: "finance",
    manifest,
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/finance/sql"
  });
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  runner = new DataContextRunner(db);
});
afterAll(async () => {
  await db?.destroy();
  await revokeModuleMembershipAtTeardown([`REVOKE ${runtimeRole} FROM jarvis_app_runtime`]);
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    for (const table of ownedTables ?? [])
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${runtimeRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${runtimeRole}`
    );
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${installRole} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${installRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${installRole} CASCADE`
    );
    await dropModuleRolesAtTeardown([installRole, runtimeRole]);
    await client.query("DELETE FROM app.module_installs WHERE module_id = 'finance'");
    await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = 'finance'");
  } finally {
    await client.end();
  }
});
import { FLEX_POOL } from "../../external-modules/finance/src/domain/flex.js";
import {
  flexPreviewHandler,
  flexConfigureHandler,
  flexAssignHandler
} from "../../external-modules/finance/src/worker/handlers/flex.js";
import {
  budgetStatusHandler,
  budgetAssignHandler,
  budgetMoveHandler
} from "../../external-modules/finance/src/worker/handlers/budget.js";
import { targetSetHandler } from "../../external-modules/finance/src/worker/handlers/targets.js";
import type { ToolFactory } from "../../external-modules/finance/src/worker/registry.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
const at = "2026-10-30T00:00:00Z";
const run = (factory: ToolFactory, input: Record<string, unknown>, user: string = ids.userA) =>
  runner.withDataContext({ actorUserId: user }, (scope) =>
    factory({
      store: async () => store(scope),
      now: () => new Date(at),
      localTimezone: "UTC",
      kv: { get: async () => null }
    } as unknown as WorkerPorts)(input)
  );
const tokens = async (user: string = ids.userA) => {
  const p = (await owner((s) => s.budgetPolicy!.get(), user))!;
  return { expectedRevision: p.revision, expectedFingerprint: p.fingerprint };
};
const mode = {
  month: "2026-10",
  mode: "flex",
  flexIds: ["groceries", "dining"],
  nonMonthlyIds: ["savings"]
};
beforeAll(async () => {
  for (const user of [ids.userA, ids.userB])
    await owner(async (s) => {
      await s.manual!.createAccount({
        accountId: "manual:flex",
        name: "Synthetic flex cash",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-09-01",
        openingBalanceCents: 100000,
        digest: "a".repeat(64),
        at
      });
      await s.budgetPolicy!.configure("USD", false, at);
      await s.setAssignment("2026-09", "groceries", 1000);
      await s.setAssignment("2026-09", "dining", 500);
      await s.setAssignment("2026-10", "groceries", 2000);
      await s.setAssignment("2026-10", "dining", 1000);
      for (const [id, date, categoryId, amountCents] of [
        ["a", "2026-09-15", "groceries", 100],
        ["b", "2026-09-15", "dining", 100],
        ["c", "2026-10-15", "groceries", 600],
        ["d", "2026-10-15", "dining", 200]
      ] as const)
        await s.manual!.createEntry({
          id: `manual:${id}`,
          accountId: "manual:flex",
          name: "Synthetic flex expense",
          date,
          amountCents,
          isoCurrency: "USD",
          categoryId,
          notes: "",
          cleared: true,
          digest: "b".repeat(64),
          at
        });
    }, user);
});
describe("reviewed flexible budgeting through installed owner SQL", () => {
  it("previews and enables one pool without changing transactions or assignments", async () => {
    const before = await owner((s) => s.getTransactionChunk("manual:flex", "2026-10"));
    expect(await run(flexPreviewHandler, mode)).toMatchObject({
      poolAssignedCents: 3000,
      poolAvailableCents: 3500
    });
    expect(await run(flexConfigureHandler, { ...mode, ...(await tokens()) })).toMatchObject({
      status: "ok"
    });
    const status = await run(budgetStatusHandler, { month: "2026-10" });
    expect(status.state).toMatchObject({
      categories: { [FLEX_POOL]: { assignedCents: 3000, activityCents: 800, availableCents: 3500 } }
    });
    expect(await owner((s) => s.getTransactionChunk("manual:flex", "2026-10"))).toEqual(before);
    expect((await owner((s) => s.getLedger("2026-10")))!.assignments).toEqual({
      groceries: 2000,
      dining: 1000
    });
  });
  it("blocks individual funding and target writes behind the active pool", async () => {
    await expect(
      run(budgetAssignHandler, {
        month: "2026-10",
        categoryId: "groceries",
        amountCents: 9999,
        previousCents: 2000,
        ...(await tokens())
      })
    ).rejects.toThrow();
    await expect(
      run(targetSetHandler, {
        month: "2026-10",
        categoryId: "groceries",
        kind: "monthly",
        amountCents: 100,
        ...(await tokens())
      })
    ).rejects.toThrow();
  });
  it("admits one of competing pool edits and counts only its stored adjustment", async () => {
    const e = await tokens();
    const results = await Promise.allSettled([
      run(flexAssignHandler, { month: "2026-10", amountCents: 4000, previousCents: 3000, ...e }),
      run(flexAssignHandler, { month: "2026-10", amountCents: 5000, previousCents: 3000, ...e })
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const status = await run(budgetStatusHandler, { month: "2026-10" });
    const total = (status.state as { categories: Record<string, { assignedCents: number }> })
      .categories[FLEX_POOL]!.assignedCents;
    expect([4000, 5000]).toContain(total);
    expect((await owner((s) => s.getLedger("2026-10")))!.assignments[FLEX_POOL]).toBe(total - 3000);
    await run(flexAssignHandler, {
      month: "2026-10",
      amountCents: 4000,
      previousCents: total,
      ...(await tokens())
    });
  });
  it("moves money atomically between a normal category and the pool", async () => {
    await run(budgetMoveHandler, {
      month: "2026-10",
      fromCategoryId: FLEX_POOL,
      toCategoryId: "utilities",
      amountCents: 100,
      ...(await tokens())
    });
    const status = await run(budgetStatusHandler, { month: "2026-10" });
    expect(status.state).toMatchObject({
      categories: { [FLEX_POOL]: { assignedCents: 3900 }, utilities: { assignedCents: 100 } }
    });
    await run(budgetMoveHandler, {
      month: "2026-10",
      fromCategoryId: "utilities",
      toCategoryId: FLEX_POOL,
      amountCents: 100,
      ...(await tokens())
    });
  });
  it("requires an exact exit allocation and conserves money and future carry", async () => {
    const exit = {
      month: "2026-10",
      mode: "envelopes",
      distribution: { groceries: 3000, dining: 1500 }
    };
    await expect(
      run(flexConfigureHandler, {
        ...exit,
        distribution: { groceries: 3000, dining: 1501 },
        ...(await tokens())
      })
    ).rejects.toThrow();
    await run(flexConfigureHandler, { ...exit, ...(await tokens()) });
    const current = await run(budgetStatusHandler, { month: "2026-10" });
    expect(current.state).toMatchObject({
      categories: {
        groceries: { assignedCents: 2700, availableCents: 3000 },
        dining: { assignedCents: 1300, availableCents: 1500 },
        [FLEX_POOL]: { availableCents: 0 }
      }
    });
    expect((await run(budgetStatusHandler, { month: "2026-11" })).state).toMatchObject({
      categories: { groceries: { availableCents: 3000 }, dining: { availableCents: 1500 } }
    });
    expect((await run(budgetStatusHandler, { month: "2026-09" })).state).toMatchObject({
      categories: { groceries: { availableCents: 900 }, dining: { availableCents: 400 } }
    });
  });
  it("returns prior pooled carry explicitly instead of hiding it on exit", async () => {
    await owner(async (s) => {
      const e = (await s.budgetPolicy!.get())!;
      expect(
        await s.commitBudgetChange({
          expected: e,
          month: "2026-09",
          assignments: [],
          activity: [],
          flexPolicy: {
            month: "2026-09",
            active: true,
            flexIds: ["groceries", "dining"],
            nonMonthlyIds: []
          }
        })
      ).toBe(true);
    }, ids.userB);
    await run(
      flexConfigureHandler,
      {
        month: "2026-10",
        mode: "envelopes",
        distribution: { groceries: 2000, dining: 1500 },
        ...(await tokens(ids.userB))
      },
      ids.userB
    );
    expect((await run(budgetStatusHandler, { month: "2026-10" }, ids.userB)).state).toMatchObject({
      categories: {
        groceries: { availableCents: 2000 },
        dining: { availableCents: 1500 },
        [FLEX_POOL]: { availableCents: 0 }
      }
    });
    const ledger = (await owner((s) => s.getLedger("2026-10"), ids.userB))!.assignments;
    expect(Object.values(ledger).reduce((sum, n) => sum + n, 0)).toBe(3000);
    expect(ledger[FLEX_POOL]).toBe(-1300);
  });
  it("does not partially change policy or amounts after a ledger correction", async () => {
    const e = (await owner((s) => s.budgetPolicy!.get()))!;
    const before = await owner((s) => s.getLedger("2026-10"));
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:later",
        accountId: "manual:flex",
        name: "Synthetic correction",
        date: "2026-10-29",
        amountCents: 1,
        isoCurrency: "USD",
        categoryId: "utilities",
        notes: "",
        cleared: true,
        digest: "c".repeat(64),
        at
      })
    );
    expect(
      await owner((s) =>
        s.commitBudgetChange({
          expected: e,
          month: "2026-10",
          assignments: [{ categoryId: FLEX_POOL, amountCents: 9999 }],
          activity: [{ actor: "user", kind: "flex.mode", params: {} }],
          flexPolicy: { month: "2026-10", active: true, flexIds: ["groceries"], nonMonthlyIds: [] }
        })
      )
    ).toBe(false);
    expect(await owner((s) => s.getLedger("2026-10"))).toEqual(before);
    expect((await owner((s) => s.flex!.policies()))[0]!.active).toBe(false);
  });
  it("preserves funded future plans and goal versions instead of rewriting them", async () => {
    await owner((s) => s.setAssignment("2026-11", "utilities", 100));
    await expect(run(flexConfigureHandler, { ...mode, ...(await tokens()) })).rejects.toThrow();
    await owner((s) => s.setAssignment("2026-11", "utilities", 0));
    await run(targetSetHandler, {
      month: "2026-11",
      categoryId: "groceries",
      kind: "monthly",
      amountCents: 100,
      ...(await tokens())
    });
    await expect(run(flexConfigureHandler, { ...mode, ...(await tokens()) })).rejects.toThrow();
  });
  it("keeps the policy history owner-scoped", async () => {
    expect((await owner((s) => s.flex!.policies())).map((p) => p.month)).toEqual(["2026-10"]);
    expect((await owner((s) => s.flex!.policies(), ids.userB)).map((p) => p.month)).toEqual([
      "2026-09",
      "2026-10"
    ]);
  });
});
