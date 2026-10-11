// external-modules/finance/src/worker/handlers/migrate.ts
//
// FIN-06b (#1166) Task 6: the one-shot per-owner KV -> SQL backfill. Queue-only
// (no assistant-tool twin — F6-D4): runs on finance.storage-migrate, copies
// every record store-sql.ts/store-kv.ts already agree on into the module
// tables via insert-ignore (never upsert — a replay after a partial crash
// must not clobber rows a concurrent/later sync has already written), then
// count-verifies with >= (a concurrent sync may add rows this run never
// read), THEN writes the storeSelector marker, THEN deletes only the KV keys
// it just copied. state:{month} budget caches are deleted here too but never
// copied (F6-D1 — a throwaway performance projection, never source of
// truth). cursor:*, link:*, rules, settings, and the
// finance.shared mirror are never read or touched. The categories taxonomy is
// copied (never deleted) into app.finance_categories on every run.
import type {
  AccountRecord,
  BudgetLedger,
  FinanceDb,
  ItemRecord,
  SnapshotChunk,
  TransactionChunk,
  TransactionRecord
} from "../../domain/index.js";
import type { Category } from "../../domain/index.js";
import { DEFAULT_CATEGORIES, FinanceKvError, NS, tableGroupFor } from "../../domain/index.js";
import type { WorkerPorts } from "../ports.js";
import type { ToolFactory } from "../registry.js";
import { MIGRATED_MARKER_KEY } from "../store.js";
import { InputError, readString } from "../validate.js";

const ITEM_PREFIX = "item:";
const LEDGER_PREFIX = "ledger:";
const STATE_PREFIX = "state:";

type MigrateCounts = {
  items: number;
  accounts: number;
  transactions: number;
  snapshotDays: number;
  assignments: number;
};

type MigrateResult = { status: "already-migrated" } | { status: "migrated"; counts: MigrateCounts };

async function insertIgnoreItem(db: FinanceDb, record: ItemRecord): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_items (owner_user_id, item_id, institution_id, connected_at, status, " +
      "last_sync_at, last_error) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6) " +
      "ON CONFLICT (owner_user_id, item_id) DO NOTHING",
    [
      record.itemId,
      record.institutionId ?? null,
      record.connectedAt,
      record.status,
      record.lastSyncAt ?? null,
      record.lastError ?? null
    ]
  );
}

async function insertIgnoreAccount(db: FinanceDb, record: AccountRecord): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_accounts (owner_user_id, account_id, item_id, name, official_name, " +
      "type, subtype, mask, balance_cents, iso_currency, updated_at, shared_to_household) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) " +
      "ON CONFLICT (owner_user_id, account_id) DO NOTHING",
    [
      record.accountId,
      record.itemId,
      record.name,
      record.officialName ?? null,
      record.type,
      record.subtype ?? null,
      record.mask ?? null,
      record.balanceCents,
      record.isoCurrency,
      record.updatedAt,
      record.sharedToHousehold ?? false
    ]
  );
}

async function insertIgnoreTransaction(db: FinanceDb, record: TransactionRecord): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_transactions (owner_user_id, id, account_id, date, amount_cents, " +
      "iso_currency, name, merchant, plaid_category, category_id, pending, " +
      "pending_transaction_id, categorized_by, notes) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) " +
      "ON CONFLICT (owner_user_id, id) DO NOTHING",
    [
      record.id,
      record.accountId,
      record.date,
      record.amountCents,
      record.isoCurrency,
      record.name,
      record.merchant ?? null,
      record.plaidCategory ?? null,
      record.categoryId ?? null,
      record.pending,
      record.pendingTransactionId ?? null,
      record.categorizedBy ?? null,
      record.notes ?? null
    ]
  );
}

async function insertIgnoreSnapshotDay(
  db: FinanceDb,
  accountId: string,
  day: string,
  balanceCents: number
): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_balance_snapshots (owner_user_id, account_id, day, balance_cents) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
      "ON CONFLICT (owner_user_id, account_id, day) DO NOTHING",
    [accountId, day, balanceCents]
  );
}

async function insertIgnoreAssignment(
  db: FinanceDb,
  month: string,
  categoryId: string,
  amountCents: number
): Promise<void> {
  await db.query(
    "INSERT INTO app.finance_budget_assignments (owner_user_id, month, category_id, assigned_cents) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
      "ON CONFLICT (owner_user_id, month, category_id) DO NOTHING",
    [month, categoryId, amountCents]
  );
}

/**
 * Copies the KV category taxonomy (or the 16 defaults when none is stored yet)
 * into app.finance_categories. Insert-ignore, so it is safe to run on every
 * reconcile, including for owners whose main migration already finished. The
 * KV taxonomy is left in place; it stays the read path until later tickets.
 */
export async function copyCategoriesToTable(ports: WorkerPorts, db: FinanceDb): Promise<void> {
  const stored = (await ports.kv.get(NS.categories, "taxonomy")) as {
    categories: Category[];
  } | null;
  const categories = stored?.categories ?? [...DEFAULT_CATEGORIES];
  const nowIso = ports.now().toISOString();
  for (const [index, category] of categories.entries()) {
    await db.query(
      "INSERT INTO app.finance_categories (owner_user_id, id, group_name, name, sort_order, " +
        "is_income, archived_at) " +
        "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6) " +
        "ON CONFLICT (owner_user_id, id) DO NOTHING",
      [
        category.id,
        tableGroupFor(category.group),
        category.name,
        index,
        category.group === "income",
        category.archived ? nowIso : null
      ]
    );
  }
}

async function countRows(db: FinanceDb, table: string): Promise<number> {
  const result = await db.query<{ n: number | string }>(`SELECT count(*)::int AS n FROM ${table}`);
  return Number(result.rows[0]?.n ?? 0);
}

/**
 * The migration core, queue-only. Order is load-bearing: every insert for
 * every table happens before any count-verify; every count-verify passes
 * before the marker is written; the marker is written before the first KV
 * delete. A crash before the marker leaves KV as the untouched source of
 * truth (storeSelector keeps reading it — worker/store.ts F6-D4); a crash
 * after the marker but before the deletes just leaves harmless leftover KV
 * rows for a future cleanup pass, never a correctness problem.
 */
export async function runStorageMigrate(ports: WorkerPorts): Promise<MigrateResult> {
  const marker = await ports.kv.get(NS.meta, MIGRATED_MARKER_KEY);
  if (marker !== null) {
    // Owners migrated before categories moved to a table still need that copy.
    if (ports.db !== null) await copyCategoriesToTable(ports, ports.db);
    return { status: "already-migrated" };
  }

  const db = ports.db;
  if (db === null) {
    // FinanceKvErrorCode has no "storage_unavailable" member (domain/errors.ts
    // is out of this task's file list) — InputError takes an arbitrary code
    // string and wrap.ts scrubs both types identically, so this is a
    // functionally equivalent substitute for the plan's FinanceKvError example.
    throw new InputError("storage_unavailable", "ctx.db is not available on this host");
  }

  // --- Read every KV source this owner has. state:* is read only to be
  // deleted below (F6-D1) — its values are never inserted anywhere. ---
  const itemKeys = (await ports.kv.list(NS.connections)).filter((key) =>
    key.startsWith(ITEM_PREFIX)
  );
  const items: ItemRecord[] = [];
  for (const key of itemKeys) {
    const record = await ports.kv.get(NS.connections, key);
    if (record) items.push(record as unknown as ItemRecord);
  }

  const accountIds = await ports.kv.list(NS.accounts);
  const accounts: AccountRecord[] = [];
  for (const accountId of accountIds) {
    const record = await ports.kv.get(NS.accounts, accountId);
    if (record) accounts.push(record as unknown as AccountRecord);
  }

  const transactionKeys = await ports.kv.list(NS.transactions);
  const transactions: TransactionRecord[] = [];
  for (const key of transactionKeys) {
    const chunk = await ports.kv.get(NS.transactions, key);
    if (chunk) transactions.push(...(chunk as unknown as TransactionChunk).transactions);
  }

  const snapshotKeys = await ports.kv.list(NS.snapshots);
  const snapshotDays: Array<{ accountId: string; day: string; balanceCents: number }> = [];
  for (const key of snapshotKeys) {
    const chunk = await ports.kv.get(NS.snapshots, key);
    if (!chunk) continue;
    // Chunk key shape `${accountId}:${YYYY-MM}` — same fixed-width slice
    // store-kv.ts's listSnapshotChunks uses (accountIds may contain ":").
    const accountId = key.slice(0, -8);
    for (const [day, balanceCents] of Object.entries((chunk as unknown as SnapshotChunk).days)) {
      snapshotDays.push({ accountId, day, balanceCents });
    }
  }

  const budgetKeys = await ports.kv.list(NS.budgets);
  const ledgerKeys = budgetKeys.filter((key) => key.startsWith(LEDGER_PREFIX));
  const stateKeys = budgetKeys.filter((key) => key.startsWith(STATE_PREFIX));
  const assignments: Array<{ month: string; categoryId: string; amountCents: number }> = [];
  for (const key of ledgerKeys) {
    const ledger = await ports.kv.get(NS.budgets, key);
    if (!ledger) continue;
    const month = key.slice(LEDGER_PREFIX.length);
    for (const [categoryId, amountCents] of Object.entries(
      (ledger as unknown as BudgetLedger).assignments
    )) {
      assignments.push({ month, categoryId, amountCents });
    }
  }

  // --- Insert-ignore every record. DO NOTHING, never DO UPDATE: a replay
  // after a partial crash must not clobber a row a concurrent/later sync has
  // already written (store-sql.ts's DO UPDATE variants are the runtime write
  // path — this is migration-only). ---
  for (const record of items) await insertIgnoreItem(db, record);
  for (const record of accounts) await insertIgnoreAccount(db, record);
  for (const record of transactions) await insertIgnoreTransaction(db, record);
  for (const snapshot of snapshotDays) {
    await insertIgnoreSnapshotDay(db, snapshot.accountId, snapshot.day, snapshot.balanceCents);
  }
  for (const assignment of assignments) {
    await insertIgnoreAssignment(
      db,
      assignment.month,
      assignment.categoryId,
      assignment.amountCents
    );
  }

  await copyCategoriesToTable(ports, db);

  // --- Count-verify with >= (a concurrent sync may have added rows this
  // invocation never read). A short count means data is missing — abort
  // before the marker or any delete. ---
  const counts: MigrateCounts = {
    items: items.length,
    accounts: accounts.length,
    transactions: transactions.length,
    snapshotDays: snapshotDays.length,
    assignments: assignments.length
  };
  const verifications: Array<[string, number]> = [
    ["app.finance_items", counts.items],
    ["app.finance_accounts", counts.accounts],
    ["app.finance_transactions", counts.transactions],
    ["app.finance_balance_snapshots", counts.snapshotDays],
    ["app.finance_budget_assignments", counts.assignments]
  ];
  for (const [table, expected] of verifications) {
    const actual = await countRows(db, table);
    if (actual < expected) {
      throw new FinanceKvError(
        "corrupt_index",
        `storage-migrate count-verify failed: ${table} has fewer rows than KV read`
      );
    }
  }

  // --- Mark BEFORE deleting anything (see doc comment above). ---
  await ports.kv.set(NS.meta, MIGRATED_MARKER_KEY, { migratedAt: ports.now().toISOString() });

  // --- Delete only what was just copied, plus the state:* cache (F6-D1).
  // cursor:*, link:*, rules, categories, settings, finance.shared are never
  // touched. ---
  for (const key of itemKeys) await ports.kv.delete(NS.connections, key);
  for (const accountId of accountIds) await ports.kv.delete(NS.accounts, accountId);
  for (const key of transactionKeys) await ports.kv.delete(NS.transactions, key);
  for (const key of snapshotKeys) await ports.kv.delete(NS.snapshots, key);
  for (const key of ledgerKeys) await ports.kv.delete(NS.budgets, key);
  for (const key of stateKeys) await ports.kv.delete(NS.budgets, key);

  return { status: "migrated", counts };
}

/**
 * Queue-only handler — no assistant-tool twin (F6-D4: pure metadata job, no
 * params). actorUserId is validated only to hold the host job-envelope shape
 * `{actorUserId, jobKind, params}`; the migrated rows' owner comes from
 * app.current_actor_user_id() in the SQL text, never this value.
 */
export const storageMigrateHandler: ToolFactory = (ports) => async (input) => {
  readString(input, "actorUserId", { required: true });
  const jobKind = readString(input, "jobKind", { required: true });
  if (jobKind !== "finance.storage-migrate") {
    throw new InputError("jobKind is not supported by this handler");
  }
  return runStorageMigrate(ports);
};
