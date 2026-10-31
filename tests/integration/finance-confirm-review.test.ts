import { blockedFinanceWrites } from "./helpers/finance-write-barrier.js";
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
let setupReady = false;
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
  setupReady = true;
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
  if (!setupReady) return;
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

import type { TransactionRecord } from "../../external-modules/finance/src/domain/index.js";
import { transactionsConfirmHandler } from "../../external-modules/finance/src/worker/handlers/transaction-bulk.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
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
        (a) => a.kind === "transaction.confirm"
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

const query = (text: string, params: unknown[] = []) =>
  runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
describe("atomic captured category confirmation", () => {
  it("confirms all captured reviews and activity without rewriting money or notes", async () => {
    await seed(
      transaction("confirm:a"),
      transaction("confirm:b", { amountCents: -301, isoCurrency: "EUR", categoryId: "transfers" })
    );
    const before = await owner((s) => s.listMonthTransactions("2026-10")),
      rows = await review(["confirm:a", "confirm:b"]),
      count = await activityCount();
    expect(await owner((s) => s.bulk!.confirm!(rows))).toBe(true);
    const after = await owner((s) => s.listMonthTransactions("2026-10"));
    expect(after).toEqual(
      before.map((r) => ({ ...r, reviewState: "confirmed", categorizedBy: "user" }))
    );
    expect(await activityCount()).toBe(count + 2);
    expect(await owner((s) => s.bulk!.confirm!(rows))).toBe(false);
    expect(await activityCount()).toBe(count + 2);
  });
  it("refuses stale, pending, split, uncategorized, unavailable-category and foreign rows as a whole", async () => {
    await seed(
      transaction("confirm:good"),
      transaction("confirm:stale"),
      transaction("confirm:pending", { pending: true }),
      transaction("confirm:split", { splits: [{ categoryId: "utilities", amountCents: 1251 }] }),
      transaction("confirm:null", { categoryId: null }),
      transaction("confirm:missing", { categoryId: "missing" })
    );
    await owner((s) => s.putTransaction(transaction("confirm:foreign")), ids.userB);
    expect(
      (await owner((s) => s.bulk!.monthRows("2026-10"))).some((r) => r.id === "confirm:foreign")
    ).toBe(false);
    const rows = await review([
        "confirm:good",
        "confirm:stale",
        "confirm:pending",
        "confirm:split",
        "confirm:null",
        "confirm:missing"
      ]),
      byId = new Map(rows.map((r) => [r.id, r]));
    const foreign = (await owner((s) => s.bulk!.monthRows("2026-10"), ids.userB)).find(
      (r) => r.id === "confirm:foreign"
    )!;
    await query("UPDATE app.finance_transactions SET amount_cents=amount_cents+1 WHERE id=$1", [
      "confirm:stale"
    ]);
    const before = await owner((s) => s.listMonthTransactions("2026-10")),
      count = await activityCount();
    for (const id of [
      "confirm:stale",
      "confirm:pending",
      "confirm:split",
      "confirm:null",
      "confirm:missing"
    ])
      expect(await owner((s) => s.bulk!.confirm!([byId.get("confirm:good")!, byId.get(id)!]))).toBe(
        false
      );
    expect(await owner((s) => s.bulk!.confirm!([byId.get("confirm:good")!, foreign]))).toBe(false);
    await query(
      "UPDATE app.finance_categories SET archived_at=$1::timestamptz WHERE id='utilities'",
      [at]
    );
    try {
      expect(await owner((s) => s.bulk!.confirm!([byId.get("confirm:good")!]))).toBe(false);
    } finally {
      await query("UPDATE app.finance_categories SET archived_at=NULL WHERE id='utilities'");
    }
    expect(await owner((s) => s.listMonthTransactions("2026-10"))).toEqual(before);
    expect(await activityCount()).toBe(count);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"), ids.userB))[0]!.reviewState
    ).toBe("needs_look");
  });
  it("preserves manual balance, clearing and statement reconciliation", async () => {
    await owner((s) =>
      s.manual!.createAccount({
        accountId: "manual:confirm",
        name: "Synthetic statement account",
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
        id: "manual:confirm:entry",
        accountId: "manual:confirm",
        date: "2026-10-15",
        name: "Synthetic cleared purchase",
        amountCents: 2000,
        isoCurrency: "USD",
        categoryId: "groceries",
        notes: "Synthetic retained note",
        cleared: true,
        digest: "b".repeat(64),
        at
      })
    );
    const statement = (await owner((s) => s.reconciliation!.read("manual:confirm", "2026-10-15")))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "confirm-statement",
          accountId: "manual:confirm",
          statementDate: "2026-10-15",
          balanceCents: 8000,
          isoCurrency: "USD",
          expectedRevision: statement.revision,
          selectedIds: ["manual:confirm:entry"],
          digest: "c".repeat(64),
          at
        })
      )
    ).toBe("created");
    await query("UPDATE app.finance_transactions SET review_state='needs_look' WHERE id=$1", [
      "manual:confirm:entry"
    ]);
    const before = (await owner((s) => s.listMonthTransactions("2026-10"))).find(
        (r) => r.id === "manual:confirm:entry"
      )!,
      balance = await owner((s) => s.getAccount("manual:confirm"));
    const refs = await review(["manual:confirm:entry"]);
    expect(await owner((s) => s.bulk!.confirm!(refs))).toBe(true);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).find((r) => r.id === before.id)
    ).toEqual({ ...before, reviewState: "confirmed", categorizedBy: "user" });
    expect(await owner((s) => s.getAccount("manual:confirm"))).toEqual(balance);
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
    const change = owner((s) => s.bulk!.confirm!(rows));
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const state = await blockedFinanceWrites(observer, "%reviewed AS MATERIALIZED%");
          expect(state).toBeGreaterThan(0);
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

  it("validates references before invoking storage", async () => {
    const run = (input: Record<string, unknown>) =>
      owner((s) =>
        transactionsConfirmHandler({ store: async () => s } as unknown as WorkerPorts)(input)
      );
    await expect(run({ rows: [] })).rejects.toThrow("between 1 and 200");
    await expect(run({ rows: [{ id: "x", writeRevision: "old" }] })).rejects.toThrow("Review each");
    const refs = await review(["confirm:good"]);
    await expect(run({ rows: [...refs, ...refs] })).rejects.toThrow("only once");
    await expect(
      run({
        rows: Array.from({ length: 201 }, (_, i) => ({
          id: String(i),
          writeRevision: "a".repeat(32)
        }))
      })
    ).rejects.toThrow("between 1 and 200");
  });
});
