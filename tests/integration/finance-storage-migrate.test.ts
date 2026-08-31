// tests/integration/finance-storage-migrate.test.ts
// FIN-06b (#1166) Task 7: proves external-modules/finance/src/worker/handlers/migrate.ts
// against REAL module tables + REAL module_kv, not the unit fake — installModule (Task
// 2's pattern) provisions the owned tables, createModuleStorageRpc (module-storage-rpc
// .test.ts's GRANT pattern) is the SQL path, and a worker-role DataContextRunner over
// app.module_kv (external-module-finance.test.ts's seedKv pattern) is the KV path, so a
// drift in either RLS policy set fails here, not in production. Six proofs: (a) SQL row
// counts match the KV seed, (b) the storeSelector marker lands in finance.meta, (c) only
// the copied keys are deleted (cursor:*/rules survive, state:* cache dies per F6-D1), (d)
// a replay against the marker is a pure no-op, (e) owner B's RLS-scoped listAccounts()
// sees none of owner A's rows, (f) a crash-replay (KV re-seeded with the SAME records,
// marker deleted, re-invoked) proves ON CONFLICT DO NOTHING absorbs the duplicate insert
// without doubling SQL rows, and rewrites the marker.
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";

import {
  DataContextRunner,
  createDatabase,
  createModuleStorageRpc,
  moduleInstallRoleName,
  moduleRuntimeRoleName,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import {
  deleteModuleKvKey,
  getModuleKvValue,
  listModuleKvKeys,
  setModuleKvValue
} from "@moss/settings";

import { installModule } from "../../scripts/module-install.js";
import { getMossDatabaseUrls } from "../../packages/db/src/urls.js";
import type {
  AccountRecord,
  FinanceDb,
  FinanceKv,
  ItemRecord,
  TransactionRecord
} from "../../external-modules/finance/src/domain/index.js";
import {
  NS,
  cursorKey,
  itemKey,
  monthKey,
  sqlStore
} from "../../external-modules/finance/src/domain/index.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { MIGRATED_MARKER_KEY } from "../../external-modules/finance/src/worker/store.js";
import { storageMigrateHandler } from "../../external-modules/finance/src/worker/handlers/migrate.js";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  ids,
  resetFoundationDatabase,
  revokeModuleMembershipAtTeardown
} from "./test-database.js";

const urls = getMossDatabaseUrls();
const moduleId = "finance";
const installRole = moduleInstallRoleName(moduleId);
const runtimeRole = moduleRuntimeRoleName(moduleId);
const ownedTables = [
  "app.finance_items",
  "app.finance_accounts",
  "app.finance_transactions",
  "app.finance_balance_snapshots",
  "app.finance_budget_assignments"
];

const NOW_1 = "2026-07-18T12:00:00.000Z";
const NOW_2 = "2026-07-18T14:00:00.000Z";

let bootstrap: Client;
let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let appDataContext: DataContextRunner;
let workerDataContext: DataContextRunner;

// ---- seed dataset: 2 items, 3 accounts, 5 transactions (2 months, one pending pair),
// 4 snapshot days, 1 ledger (2 assignments), 1 state cache row, 1 cursor, 1 rule. ----

const ITEM_1: ItemRecord = {
  itemId: "item-1",
  institutionId: "ins_1",
  connectedAt: "2026-06-01T00:00:00Z",
  status: "connected",
  lastSyncAt: "2026-07-15T00:00:00Z"
};
const ITEM_2: ItemRecord = {
  itemId: "item-2",
  institutionId: "ins_2",
  connectedAt: "2026-06-10T00:00:00Z",
  status: "connected"
};

const ACCOUNT_1: AccountRecord = {
  accountId: "acc-1",
  itemId: "item-1",
  name: "Checking",
  officialName: null,
  type: "depository",
  subtype: "checking",
  mask: "0001",
  balanceCents: 500000,
  isoCurrency: "USD",
  updatedAt: "2026-07-18T06:00:00Z"
};
const ACCOUNT_2: AccountRecord = {
  accountId: "acc-2",
  itemId: "item-1",
  name: "Savings",
  officialName: null,
  type: "depository",
  subtype: "savings",
  mask: "0002",
  balanceCents: 1200000,
  isoCurrency: "USD",
  updatedAt: "2026-07-18T06:00:00Z"
};
const ACCOUNT_3: AccountRecord = {
  accountId: "acc-3",
  itemId: "item-2",
  name: "Credit Card",
  officialName: "Acme Rewards Card",
  type: "credit",
  subtype: "credit card",
  mask: "0003",
  balanceCents: -45000,
  isoCurrency: "USD",
  updatedAt: "2026-07-18T06:00:00Z"
};

const TXN_JUNE_1: TransactionRecord = {
  id: "txn-1",
  accountId: "acc-1",
  date: "2026-06-05",
  amountCents: 1200,
  isoCurrency: "USD",
  name: "Coffee Shop",
  merchant: "Coffee Shop",
  plaidCategory: "Food and Drink",
  categoryId: null,
  pending: false,
  pendingTransactionId: null,
  categorizedBy: null
};
const TXN_JUNE_2: TransactionRecord = {
  id: "txn-2",
  accountId: "acc-1",
  date: "2026-06-20",
  amountCents: 8000,
  isoCurrency: "USD",
  name: "Grocery Store",
  merchant: "Grocery Store",
  plaidCategory: "Food and Drink",
  categoryId: null,
  pending: false,
  pendingTransactionId: null,
  categorizedBy: null
};
// A pending/posted pair — same underlying purchase, both must survive the copy.
const TXN_JULY_PENDING: TransactionRecord = {
  id: "txn-3-pending",
  accountId: "acc-1",
  date: "2026-07-10",
  amountCents: 4500,
  isoCurrency: "USD",
  name: "Gas Station (pending)",
  merchant: "Gas Station",
  plaidCategory: "Transportation",
  categoryId: null,
  pending: true,
  pendingTransactionId: null,
  categorizedBy: null
};
const TXN_JULY_POSTED: TransactionRecord = {
  id: "txn-3-posted",
  accountId: "acc-1",
  date: "2026-07-11",
  amountCents: 4500,
  isoCurrency: "USD",
  name: "Gas Station",
  merchant: "Gas Station",
  plaidCategory: "Transportation",
  categoryId: null,
  pending: false,
  pendingTransactionId: "txn-3-pending",
  categorizedBy: null
};
const TXN_JULY_SAVINGS: TransactionRecord = {
  id: "txn-4",
  accountId: "acc-2",
  date: "2026-07-05",
  amountCents: 200000,
  isoCurrency: "USD",
  name: "Transfer In",
  merchant: null,
  plaidCategory: null,
  categoryId: null,
  pending: false,
  pendingTransactionId: null,
  categorizedBy: null
};

const JUNE_CHUNK_KEY = monthKey(ACCOUNT_1.accountId, "2026-06-05");
const JULY_CHECKING_CHUNK_KEY = monthKey(ACCOUNT_1.accountId, "2026-07-10");
const JULY_SAVINGS_CHUNK_KEY = monthKey(ACCOUNT_2.accountId, "2026-07-05");

const EXPECTED_COUNTS = { items: 2, accounts: 3, transactions: 5, snapshotDays: 4, assignments: 2 };

/** Real module KV over app.module_kv (worker-role RLS), scope "user" — mirrors
 * external-module-finance.test.ts's seedKv pattern generalized to the full FinanceKv shape. */
function kvFor(ownerUserId: string): FinanceKv {
  const withKv = <T>(fn: (scopedDb: DataContextDb) => Promise<T>): Promise<T> =>
    workerDataContext.withDataContext(
      { actorUserId: ownerUserId, requestId: `fin06-migrate-kv-${ownerUserId.slice(-4)}` },
      async (scopedDb) => {
        await sql`SELECT set_config('app.current_module_id', ${moduleId}, true)`.execute(
          scopedDb.db
        );
        return fn(scopedDb);
      }
    );
  return {
    get: (namespace, key) =>
      withKv((scopedDb) =>
        getModuleKvValue(scopedDb, { moduleId, namespace, scope: "user", ownerUserId, key })
      ),
    set: (namespace, key, value) =>
      withKv((scopedDb) =>
        setModuleKvValue(scopedDb, { moduleId, namespace, scope: "user", ownerUserId, key }, value)
      ),
    delete: (namespace, key) =>
      withKv((scopedDb) =>
        deleteModuleKvKey(scopedDb, { moduleId, namespace, scope: "user", ownerUserId, key })
      ),
    list: (namespace) =>
      withKv((scopedDb) =>
        listModuleKvKeys(scopedDb, { moduleId, namespace, scope: "user", ownerUserId })
      )
  };
}

/** Real module SQL over createModuleStorageRpc (app-role RLS) — module-storage-rpc.test.ts's
 * adapter, spreading the readonly rows into the mutable array FinanceDb.query expects. */
function dbFor(scopedDb: DataContextDb): FinanceDb {
  const rpc = createModuleStorageRpc(scopedDb, moduleId);
  return {
    async query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]) {
      const result = await rpc.query<T>(text, params);
      return { rows: [...result.rows] };
    }
  };
}

// Every non-kv/db port throws on access (finance-storage-migrate.test.ts unit pattern) —
// a pass here proves the handler never reaches the mirror, plaid, tokens, creds, settings,
// or store() for this job.
function makePorts(kv: FinanceKv, db: FinanceDb, nowIso: string): WorkerPorts {
  return {
    kv,
    mirror: {
      get: async () => {
        throw new Error("storage-migrate must not read the household mirror");
      },
      set: async () => {
        throw new Error("storage-migrate must not write the household mirror");
      },
      delete: async () => {
        throw new Error("storage-migrate must not delete from the household mirror");
      },
      list: async () => {
        throw new Error("storage-migrate must not list the household mirror");
      }
    },
    ai: null,
    db,
    plaid: null,
    tokens: {
      read: async () => {
        throw new Error("storage-migrate must not read tokens");
      },
      write: async () => {
        throw new Error("storage-migrate must not write tokens");
      }
    },
    creds: {
      get: async () => {
        throw new Error("storage-migrate must not read creds");
      }
    },
    settings: {
      getEnvironment: async () => {
        throw new Error("storage-migrate must not read settings");
      }
    },
    isAdmin: false,
    now: () => new Date(nowIso),
    store: async () => {
      throw new Error("storage-migrate reads kv/db directly, never via store()");
    }
  };
}

async function runMigrateForOwner(ownerUserId: string, nowIso: string) {
  const kv = kvFor(ownerUserId);
  return appDataContext.withDataContext(
    { actorUserId: ownerUserId, requestId: `fin06-migrate-run-${ownerUserId.slice(-4)}` },
    async (scopedDb) => {
      const db = dbFor(scopedDb);
      return storageMigrateHandler(makePorts(kv, db, nowIso))({
        actorUserId: ownerUserId,
        jobKind: "finance.storage-migrate"
      });
    }
  );
}

async function seedOwnerAData(): Promise<void> {
  const kv = kvFor(ids.userA);

  await kv.set(
    NS.connections,
    itemKey(ITEM_1.itemId),
    ITEM_1 as unknown as Record<string, unknown>
  );
  await kv.set(
    NS.connections,
    itemKey(ITEM_2.itemId),
    ITEM_2 as unknown as Record<string, unknown>
  );
  // Survivor — never read or copied by storage-migrate.
  await kv.set(NS.connections, cursorKey("item-1"), { cursor: "opaque-cursor-value" });

  await kv.set(NS.accounts, ACCOUNT_1.accountId, ACCOUNT_1 as unknown as Record<string, unknown>);
  await kv.set(NS.accounts, ACCOUNT_2.accountId, ACCOUNT_2 as unknown as Record<string, unknown>);
  await kv.set(NS.accounts, ACCOUNT_3.accountId, ACCOUNT_3 as unknown as Record<string, unknown>);

  await kv.set(NS.transactions, JUNE_CHUNK_KEY, { transactions: [TXN_JUNE_1, TXN_JUNE_2] });
  await kv.set(NS.transactions, JULY_CHECKING_CHUNK_KEY, {
    transactions: [TXN_JULY_PENDING, TXN_JULY_POSTED]
  });
  await kv.set(NS.transactions, JULY_SAVINGS_CHUNK_KEY, { transactions: [TXN_JULY_SAVINGS] });

  await kv.set(NS.snapshots, "acc-1:2026-07", {
    days: { "2026-07-01": 490000, "2026-07-02": 495000, "2026-07-03": 500000 }
  });
  await kv.set(NS.snapshots, "acc-2:2026-07", { days: { "2026-07-01": 1195000 } });

  await kv.set(NS.budgets, "ledger:2026-07", { assignments: { groceries: 30000, dining: 15000 } });
  // Cache — must be deleted but never copied into SQL (F6-D1).
  await kv.set(NS.budgets, "state:2026-07", {
    tbbCents: 0,
    categories: {},
    computedAt: "2026-07-01T00:00:00.000Z"
  });

  // Survivor — never read or copied by storage-migrate.
  await kv.set(NS.rules, "trader-joes", {
    payeeKey: "trader joes",
    categoryId: "groceries",
    createdAt: "2026-06-01T00:00:00Z"
  });
}

async function countOwnerRows(table: string, ownerUserId: string): Promise<number> {
  const result = await bootstrap.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id = $1`,
    [ownerUserId]
  );
  return Number(result.rows[0]?.n ?? 0);
}

async function assertSqlCountsMatchSeed(ownerUserId: string): Promise<void> {
  expect(await countOwnerRows("app.finance_items", ownerUserId)).toBe(EXPECTED_COUNTS.items);
  expect(await countOwnerRows("app.finance_accounts", ownerUserId)).toBe(EXPECTED_COUNTS.accounts);
  expect(await countOwnerRows("app.finance_transactions", ownerUserId)).toBe(
    EXPECTED_COUNTS.transactions
  );
  expect(await countOwnerRows("app.finance_balance_snapshots", ownerUserId)).toBe(
    EXPECTED_COUNTS.snapshotDays
  );
  expect(await countOwnerRows("app.finance_budget_assignments", ownerUserId)).toBe(
    EXPECTED_COUNTS.assignments
  );
}

async function assertMigratedKvGoneSurvivorsRemain(ownerUserId: string): Promise<void> {
  const kv = kvFor(ownerUserId);

  expect(await kv.get(NS.connections, itemKey(ITEM_1.itemId))).toBeNull();
  expect(await kv.get(NS.connections, itemKey(ITEM_2.itemId))).toBeNull();
  expect(await kv.get(NS.accounts, ACCOUNT_1.accountId)).toBeNull();
  expect(await kv.get(NS.accounts, ACCOUNT_2.accountId)).toBeNull();
  expect(await kv.get(NS.accounts, ACCOUNT_3.accountId)).toBeNull();
  expect(await kv.get(NS.transactions, JUNE_CHUNK_KEY)).toBeNull();
  expect(await kv.get(NS.transactions, JULY_CHECKING_CHUNK_KEY)).toBeNull();
  expect(await kv.get(NS.transactions, JULY_SAVINGS_CHUNK_KEY)).toBeNull();
  expect(await kv.get(NS.snapshots, "acc-1:2026-07")).toBeNull();
  expect(await kv.get(NS.snapshots, "acc-2:2026-07")).toBeNull();
  expect(await kv.get(NS.budgets, "ledger:2026-07")).toBeNull();
  // state:* cache dies here too (F6-D1) — deleted, never copied.
  expect(await kv.get(NS.budgets, "state:2026-07")).toBeNull();

  // Untouched: cursor/rules.
  expect(await kv.get(NS.connections, cursorKey("item-1"))).not.toBeNull();
  expect(await kv.get(NS.rules, "trader-joes")).not.toBeNull();
}

beforeAll(async () => {
  // resetFoundationDatabase (not the empty variant) seeds app.users rows for ids.userA/
  // userB/adminUser — required by module_kv's and the finance tables' owner_user_id FK.
  await resetFoundationDatabase();
  await installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: urls.bootstrap,
    migrationConnectionString: urls.migration,
    migrationsDirectory: "external-modules/finance/sql"
  });

  bootstrap = new Client({ connectionString: connectionStrings.bootstrap });
  await bootstrap.connect();
  // module-storage-rpc.test.ts pattern: let the app-runtime role assume the module's
  // runtime role for createModuleStorageRpc's per-call SET LOCAL ROLE. Membership is
  // cluster-global, so it goes through the lock rather than this connection (#1013).
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
  // external-module-job-search-kv-isolation.test.ts pattern: the lightweight direct
  // bootstrap insert that satisfies jarvis_worker_runtime's module_kv RLS policy
  // (0157_module_worker_runtime_access.sql requires an enabled app.external_modules row)
  // without standing up a full API server.
  await bootstrap.query(
    `INSERT INTO app.external_modules (id, status, manifest_hash, package_hash, enabled_at, enabled_by)
     VALUES ('finance', 'enabled', 'sha256:finance', 'sha256:finance', now(), $1)`,
    [ids.adminUser]
  );

  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  appDataContext = new DataContextRunner(appDb);
  workerDataContext = new DataContextRunner(workerDb);
});

afterAll(async () => {
  await Promise.allSettled([appDb?.destroy(), workerDb?.destroy()]);

  // Role membership first — Postgres refuses to revoke a grant-option privilege while a
  // dependent downstream grant still exists (module-storage-rpc.test.ts's ordering). It is also
  // cluster-global, so it runs under the lock on its own session (#1013).
  await revokeModuleMembershipAtTeardown([`REVOKE ${runtimeRole} FROM jarvis_app_runtime`]);

  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    for (const table of ownedTables) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
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
    await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);
    await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
    await client.query("DELETE FROM app.external_modules WHERE id = $1", [moduleId]);
  } finally {
    await client.end();
  }
  await bootstrap?.end();
});

describe("finance.storage-migrate integration (FIN-06b #1166)", () => {
  it("copies KV into SQL, marks, cleans selectively, replays as a no-op, respects RLS, and survives a crash-replay", async () => {
    await seedOwnerAData();

    // First run: real insert-ignore + count-verify + mark + selective delete.
    const first = await runMigrateForOwner(ids.userA, NOW_1);
    expect(first).toEqual({ status: "migrated", counts: EXPECTED_COUNTS });

    // (a) SQL row counts match the seed.
    await assertSqlCountsMatchSeed(ids.userA);

    // (b) marker written to finance.meta.
    expect(await kvFor(ids.userA).get(NS.meta, MIGRATED_MARKER_KEY)).toEqual({ migratedAt: NOW_1 });

    // (c) selective KV cleanup: migrated keys gone, cursor:*/rule survive, state:* cache gone.
    await assertMigratedKvGoneSurvivorsRemain(ids.userA);

    // (d) replay against the marker is a pure no-op.
    const replay = await runMigrateForOwner(ids.userA, NOW_1);
    expect(replay).toEqual({ status: "already-migrated" });
    await assertSqlCountsMatchSeed(ids.userA);

    // (e) RLS proof: owner B's runtime-scoped listAccounts() sees none of owner A's rows.
    const accountsForB = await appDataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "fin06-migrate-rls-check" },
      async (scopedDb) => sqlStore(dbFor(scopedDb)).listAccounts()
    );
    expect(accountsForB).toEqual([]);

    // (f) crash-replay proof: re-seed the SAME records (simulating a crash that happened
    // after insert+count-verify but before the marker/delete step, so KV still holds what
    // was already copied), delete the marker, and re-invoke. ON CONFLICT DO NOTHING must
    // absorb every duplicate insert — SQL counts stay put, never double — and the marker
    // must be rewritten with the new clock value.
    await seedOwnerAData();
    await kvFor(ids.userA).delete(NS.meta, MIGRATED_MARKER_KEY);

    const crashReplay = await runMigrateForOwner(ids.userA, NOW_2);
    expect(crashReplay).toEqual({ status: "migrated", counts: EXPECTED_COUNTS });

    await assertSqlCountsMatchSeed(ids.userA); // unchanged — not doubled
    expect(await kvFor(ids.userA).get(NS.meta, MIGRATED_MARKER_KEY)).toEqual({ migratedAt: NOW_2 });
    await assertMigratedKvGoneSurvivorsRemain(ids.userA);
  });
});
