import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
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
import { transactionsBulkCategoryHandler } from "../../external-modules/finance/src/worker/handlers/transaction-bulk.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
const at = "2026-10-30T00:00:00Z";
const transaction = (id: string, extra: Partial<TransactionRecord> = {}): TransactionRecord => ({
  id,
  accountId: "synthetic:account",
  date: "2026-10-15",
  amountCents: 1251,
  isoCurrency: "USD",
  name: "Synthetic purchase",
  merchant: null,
  plaidCategory: null,
  categoryId: "utilities",
  pending: false,
  pendingTransactionId: null,
  categorizedBy: "user",
  reviewState: "needs_look",
  notes: "Synthetic note",
  ...extra
});
async function seed(...rows: TransactionRecord[]) {
  await owner(async (s) => {
    for (const row of rows) await s.putTransaction(row);
  });
}
const review = (ids: string[]) =>
  owner(async (s) =>
    (await s.bulk!.monthRows("2026-10"))
      .filter((r) => ids.includes(r.id))
      .map(({ id, writeRevision }) => ({ id, writeRevision }))
  );
const activityCount = () =>
  owner(
    async (s) =>
      (await s.listActivity("2026-10-01", "2026-11-01", 100)).filter(
        (a) => a.kind === "transaction.categorize"
      ).length
  );
beforeAll(async () => {
  for (const user of [ids.userA, ids.userB])
    await owner(async (s) => {
      await s.budgetPolicy!.configure("USD", false, at);
      await s.putAccount({
        accountId: "synthetic:account",
        itemId: null,
        name: "Synthetic account",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: null,
        balanceCents: 10000,
        isoCurrency: "USD",
        updatedAt: at
      });
    }, user);
});
describe("atomic reviewed transaction categorization", () => {
  it("reads row values and revision together and commits metadata without moving money", async () => {
    await seed(transaction("bulk:a"), transaction("bulk:b", { amountCents: -301 }));
    const before = await owner((s) => s.listMonthTransactions("2026-10"));
    const reviewed = await review(["bulk:a", "bulk:b"]);
    expect(reviewed).toHaveLength(2);
    expect(reviewed.every((r) => /^[a-f0-9]{32}$/.test(r.writeRevision))).toBe(true);
    const count = await activityCount();
    expect(await owner((s) => s.bulk!.categorize(reviewed, "groceries"))).toBe(true);
    expect(await activityCount()).toBe(count + 2);
    const after = await owner((s) => s.listMonthTransactions("2026-10"));
    expect(after).toEqual(
      before.map((r) => ({
        ...r,
        categoryId: "groceries",
        reviewState: "confirmed",
        categorizedBy: "user"
      }))
    );
    expect(await owner((s) => s.bulk!.categorize(reviewed, "dining"))).toBe(false);
    expect(await activityCount()).toBe(count + 2);
  });
  it("rejects any foreign, missing, pending, split, duplicate or stale row without partial changes", async () => {
    await seed(
      transaction("bulk:good"),
      transaction("bulk:pending", { pending: true }),
      transaction("bulk:split", { splits: [{ categoryId: "utilities", amountCents: 1251 }] }),
      transaction("bulk:stale")
    );
    await owner((s) => s.putTransaction(transaction("bulk:foreign")), ids.userB);
    const good = (await review(["bulk:good"]))[0]!;
    const stale = (await review(["bulk:stale"]))[0]!;
    await seed(transaction("bulk:stale", { categoryId: "dining" }));
    const foreign = await owner(
      async (s) => (await s.bulk!.monthRows("2026-10")).find((r) => r.id === "bulk:foreign")!,
      ids.userB
    );
    const bad = [
      { id: "bulk:missing", writeRevision: "a".repeat(32) },
      foreign,
      ...(await review(["bulk:pending", "bulk:split"])),
      stale,
      good
    ];
    const before = await owner((s) => s.listMonthTransactions("2026-10")),
      count = await activityCount();
    for (const row of bad)
      expect(await owner((s) => s.bulk!.categorize([good, row], "groceries"))).toBe(false);
    expect(await owner((s) => s.bulk!.categorize([good], "transfers"))).toBe(false);
    expect(await owner((s) => s.bulk!.categorize([good], "missing"))).toBe(false);
    expect(await owner((s) => s.listMonthTransactions("2026-10"))).toEqual(before);
    expect(await activityCount()).toBe(count);
    expect(
      (await owner((s) => s.bulk!.monthRows("2026-10"))).some((r) => r.id === "bulk:foreign")
    ).toBe(false);
    expect((await owner((s) => s.listMonthTransactions("2026-10"), ids.userB))[0]?.categoryId).toBe(
      "utilities"
    );
  });
  it("allows metadata review on reconciled manual entries without changing their ledger", async () => {
    await owner((s) =>
      s.manual!.createAccount({
        accountId: "manual:bulk",
        name: "Synthetic manual",
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-10-01",
        openingBalanceCents: 10000,
        digest: "a".repeat(64),
        at
      })
    );
    await owner((s) =>
      s.manual!.createEntry({
        id: "manual:bulk-entry",
        accountId: "manual:bulk",
        name: "Synthetic reconciled purchase",
        date: "2026-10-15",
        amountCents: 2000,
        isoCurrency: "USD",
        categoryId: "utilities",
        notes: "Synthetic retained note",
        cleared: true,
        digest: "b".repeat(64),
        at
      })
    );
    const statement = (await owner((s) => s.reconciliation!.read("manual:bulk", "2026-10-15")))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "reconcile:bulk",
          accountId: "manual:bulk",
          statementDate: "2026-10-15",
          balanceCents: 8000,
          isoCurrency: "USD",
          expectedRevision: statement.revision,
          selectedIds: ["manual:bulk-entry"],
          digest: "c".repeat(64),
          at
        })
      )
    ).toBe("created");
    const before = await owner((s) => s.getAccount("manual:bulk"));
    const entry = (await owner((s) => s.bulk!.monthRows("2026-10"))).find(
      (r) => r.id === "manual:bulk-entry"
    )!;
    expect(await owner((s) => s.bulk!.categorize([entry], "groceries"))).toBe(true);
    expect(await owner((s) => s.getAccount("manual:bulk"))).toEqual(before);
    const saved = (await owner((s) => s.listMonthTransactions("2026-10"))).find(
      (r) => r.id === entry.id
    )!;
    const { writeRevision: _revision, ...unchanged } = entry;
    expect(entry.reconciledAt).not.toBeNull();
    expect(saved).toEqual({
      ...unchanged,
      categoryId: "groceries",
      reviewState: "confirmed",
      categorizedBy: "user"
    });
  });
  it("admits only one overlapping batch and never partly categorizes its competitor", async () => {
    await seed(...["a", "b", "c"].map((id) => transaction(`race:${id}`)));
    const rows = await review(["race:a", "race:b", "race:c"]),
      byId = new Map(rows.map((r) => [r.id, r]));
    const count = await activityCount();
    const results = await Promise.all([
      owner((s) => s.bulk!.categorize([byId.get("race:a")!, byId.get("race:b")!], "groceries")),
      owner((s) => s.bulk!.categorize([byId.get("race:b")!, byId.get("race:c")!], "dining"))
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
      r.id.startsWith("race:")
    );
    expect(Object.fromEntries(after.map((r) => [r.id, r.categoryId]))).toEqual(
      results[0]
        ? { "race:a": "groceries", "race:b": "groceries", "race:c": "utilities" }
        : { "race:a": "utilities", "race:b": "dining", "race:c": "dining" }
    );
    expect(await activityCount()).toBe(count + 2);
  });
  it("rechecks a row changed while blocked without updating an earlier selected row", async () => {
    await seed(transaction("lock:a"), transaction("lock:b"));
    const rows = await review(["lock:a", "lock:b"]),
      count = await activityCount();
    let unlock!: () => void, locked!: () => void;
    const untilRelease = new Promise<void>((done) => {
      unlock = done;
    });
    const acquired = new Promise<void>((done) => {
      locked = done;
    });
    const blocker = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query("SELECT id FROM app.finance_transactions WHERE id=$1 FOR UPDATE", ["lock:b"]);
      locked();
      await untilRelease;
      await rpc.query("UPDATE app.finance_transactions SET category_id='dining' WHERE id=$1", [
        "lock:b"
      ]);
    });
    await acquired;
    const change = owner((s) => s.bulk!.categorize(rows, "groceries"));
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const state = await observer.query(
            "SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%reviewed AS MATERIALIZED%' AND pid<>pg_backend_pid()"
          );
          expect(state.rows[0].waiting).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 }
      );
    } finally {
      unlock();
      await observer.end();
    }
    await blocker;
    expect(await change).toBe(false);
    const saved = (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
      r.id.startsWith("lock:")
    );
    expect(Object.fromEntries(saved.map((r) => [r.id, r.categoryId]))).toEqual({
      "lock:a": "utilities",
      "lock:b": "dining"
    });
    expect(await activityCount()).toBe(count);
  });
  it("validates batch bounds and category before invoking storage", async () => {
    const run = (input: Record<string, unknown>) =>
      owner((s) =>
        transactionsBulkCategoryHandler({
          store: async () => s,
          kv: { get: async () => null }
        } as unknown as WorkerPorts)(input)
      );
    await expect(
      run({
        rows: Array.from({ length: 201 }, (_, index) => ({
          id: `oversize:${index}`,
          writeRevision: "a".repeat(32)
        })),
        categoryId: "groceries"
      })
    ).rejects.toThrow("between 1 and 200");
    await expect(run({ rows: [], categoryId: "groceries" })).rejects.toThrow("between 1 and 200");
    await expect(
      run({ rows: [{ id: "x", writeRevision: "old" }], categoryId: "groceries" })
    ).rejects.toThrow("Review each");
    const rows = await review(["bulk:good"]);
    await expect(run({ rows: [...rows, ...rows], categoryId: "groceries" })).rejects.toThrow(
      "only once"
    );
    await expect(run({ rows, categoryId: "transfers" })).rejects.toThrow("live non-transfer");
  });
});
