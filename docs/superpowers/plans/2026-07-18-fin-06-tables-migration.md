# FIN-06 — Finance KV → Module-Owned Tables Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the finance module's five high-volume KV namespaces onto module-owned Postgres tables (`app.finance_*`) via the #914 data plane and the new #1167 `ctx.db.query`, with a per-owner idempotent backfill job and zero product-behavior change.

**Architecture:** FIN-06a ships the DDL (`external-modules/finance/sql/`) + manifest `database.ownedTables`; FIN-06b ships a `FinanceStore` port with KV and SQL implementations selected per owner by a `storage:migrated` marker, the `finance.storage-migrate` backfill handler, and a small generic platform seam (`worker.reconcileJobs`) that enqueues it per active user on reconcile; FIN-06c cuts every handler over to the store, kills the FIN-03 `state:{month}` cache, and proves the ETL through the four existing UAT specs unchanged plus a new KV-gone assertion.

**Tech Stack:** #1167 `ctx.db.query` (classifier + D5 bounds), `scripts/module-install.ts` phased installer, `pg-boss` singleton sends, existing finance domain functions (kept, fed from SQL rows).

**Spec:** `docs/superpowers/specs/2026-07-18-fin-06-tables-migration-delta.md` (approved; PR #1168 = record). Issues: #1166 (this build), #1167 (platform prereq, merged). Branch: `feat/1166-fin-06-tables` off origin/main. ONE PR closing #1166.

## Global Constraints

- **Secrets:** Plaid tokens live ONLY in `app.module_credentials`; never in tables, KV, job payloads, logs, exports, AI prompts. `finance.storage-migrate` payloads are metadata-only (actor id, job kind, manifest hash — NO params).
- **Owner column:** every table row's `owner_user_id` is written as `app.current_actor_user_id()` inside the SQL text — module code never handles its own user id. RLS (platform-generated, FORCE, owner-only) does the read scoping; queries never add redundant owner filters.
- **Date columns:** `date`/`day` are SQL `date` and MUST always be selected as `date::text` / `day::text` — node-pg parses raw `date` to a JS `Date`, which JSON-serializes to the wrong shape across the RPC. Never select a bare date column.
- **Cents columns:** `bigint`. node-pg returns int8 as a string across the RPC — every mapper converts with `Number(...)` (exact below 2^53; cents amounts are far below).
- **Timestamps** (`connected_at`, `updated_at`, `last_sync_at`) are **text** columns: they are opaque ISO strings only ever round-tripped for display, never queried; text guarantees exact round-trip.
- **Migration files:** one DDL statement per file, first command in the `module-sql-runner.ts` allowlist (CREATE TABLE / CREATE [UNIQUE] INDEX / ALTER TABLE / DROP INDEX / COMMENT ON). Never edit an applied file — the runner hash-checks.
- **Statement classifier limits** (`packages/db/src/module-statement-classify.ts`): no `E'...'` strings, no `U&`, no `set_config`, no dollar-quoted strings, single statement only. All SQL in this plan is written to pass it — keep it that way (e.g. no `E'\n'`).
- **Chunk sort order** is the contract: transactions within a month sort `date DESC, id ASC`. Both store impls must return that order.
- **Handler envelope:** queue handlers receive `{actorUserId, jobKind, idempotencyKey, params}` in `ctx.input` — command fields under `params`, never flat (#1147).
- Comment density: generous why-comments citing issue numbers (#1166, spec decision ids F6-D1..D5) — Ben's standing rule.
- Commits: one per task, explicit `git add <paths>` (never `-A`, never `.claude/context-meter.log`), prettier before commit, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`, body line "Not user-visible: finance storage now uses module-owned tables; screens and tools behave identically."
- Existing UAT seeds stay KV-shaped and the four finance specs must pass **unchanged** (same dollar figures) — that is the ETL proof (F6-D5).

## File Structure

| File                                                                                        | Responsibility                                                                                                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `external-modules/finance/sql/0001…0008_*.sql`                                              | Create: five tables + three indexes (FIN-06a)                                                                                          |
| `external-modules/finance/jarvis.module.json`                                               | Modify: `database.ownedTables`, `finance.meta` namespace, `finance.storage-migrate` queue, `worker.reconcileJobs`, version 0.4.0→0.5.0 |
| `packages/module-sdk/src/index.ts`                                                          | Modify: `ExternalModuleReconcileJobDeclaration` type on the worker declaration                                                         |
| `packages/module-registry/src/external/validate.ts`                                         | Modify: parse/validate `worker.reconcileJobs`                                                                                          |
| `packages/module-registry/src/external/job-reconciler.ts`                                   | Modify: per-user one-shot enqueue for `reconcileJobs`                                                                                  |
| `external-modules/finance/src/domain/store-port.ts`                                         | Create: `FinanceStore` + `FinanceDb` ports (domain-level, no SDK imports)                                                              |
| `external-modules/finance/src/domain/store-kv.ts`                                           | Create: KV-backed `FinanceStore` (extracted from today's handler logic)                                                                |
| `external-modules/finance/src/domain/store-sql.ts`                                          | Create: SQL-backed `FinanceStore` over `FinanceDb`                                                                                     |
| `external-modules/finance/src/worker/store.ts`                                              | Create: per-owner dual-read selector on the `storage:migrated` marker                                                                  |
| `external-modules/finance/src/worker/handlers/migrate.ts`                                   | Create: `finance.storage-migrate` backfill handler                                                                                     |
| `external-modules/finance/src/worker/handlers/{connect,sync,feed,budget,reports,shared}.ts` | Modify: cut reads/writes over to `ports.store` (FIN-06c)                                                                               |
| `external-modules/finance/src/worker/{ports,index,registry}.ts`                             | Modify: `store` port wiring + `storage.migrate` handler registration                                                                   |
| `tests/integration/finance-tables-install.test.ts`                                          | Create: real installer run over the real `sql/` directory                                                                              |
| `tests/integration/finance-storage-migrate.test.ts`                                         | Create: migrate handler against real RLS'd tables (replay, crash, count-mismatch)                                                      |
| `tests/unit/module-job-reconciler.test.ts`                                                  | Modify: reconcileJobs enqueue coverage                                                                                                 |
| `tests/unit/finance-*.test.ts`                                                              | Modify: handler tests move to `kvStore(fakeKv)`; new store tests                                                                       |
| `tests/uat/specs/finance-reports.uat.spec.ts`                                               | Modify: KV-gone poll assertion                                                                                                         |

Slice boundaries: Tasks 1–2 = FIN-06a · Tasks 3–7 = FIN-06b · Tasks 8–11 = FIN-06c · Task 12 = gate + PR.

---

### Task 1: DDL migration files + manifest `database.ownedTables` (FIN-06a)

**Files:**

- Create: `external-modules/finance/sql/0001_create_finance_items.sql` … `0008_create_finance_budget_assignments.sql`
- Modify: `external-modules/finance/jarvis.module.json` (add `database`, bump version)
- Test: `tests/unit/finance-sql-files.test.ts`

**Interfaces:**

- Produces: the five table shapes every later task's SQL targets. Column names are the snake_case of the record fields in `external-modules/finance/src/domain/records.ts` — 1:1, nothing added, nothing renamed.

- [ ] **Step 1: Write the failing unit test** — every sql file passes the module-sql-runner wire contract:

```ts
// tests/unit/finance-sql-files.test.ts
// FIN-06a (#1166): the finance DDL ships as module migrations and must satisfy
// the #914 D3 wire contract (one statement, allowlisted first command) BEFORE
// an install ever runs — loadModuleMigrationFiles throws on violations.
import { describe, expect, it } from "vitest";
import { loadModuleMigrationFiles } from "@jarv1s/db";

describe("finance module sql directory", () => {
  it("loads all eight migration files through the module-sql-runner validator", async () => {
    const files = await loadModuleMigrationFiles("external-modules/finance/sql");
    expect(files.map((file) => file.version)).toEqual([
      "0001_create_finance_items",
      "0002_create_finance_accounts",
      "0003_index_finance_accounts_item",
      "0004_create_finance_transactions",
      "0005_index_finance_transactions_account_date",
      "0006_index_finance_transactions_date",
      "0007_create_finance_balance_snapshots",
      "0008_create_finance_budget_assignments"
    ]);
  });
});
```

(Adjust `version` extraction to whatever `loadModuleMigrationFiles` actually returns — check its return type in `packages/db/src/migrations/module-sql-runner.ts` and match the existing #914 tests; strip `.sql` if versions include it.)

- [ ] **Step 2: Run it — must fail** with an ENOENT-driven empty array / mismatch: `pnpm exec vitest run tests/unit/finance-sql-files.test.ts`

- [ ] **Step 3: Write the eight files.** One statement each, exactly:

`0001_create_finance_items.sql` (from `ItemRecord`; F6-D2 mandatory owner column):

```sql
CREATE TABLE app.finance_items (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  item_id text NOT NULL,
  institution_id text,
  connected_at text NOT NULL,
  status text NOT NULL,
  last_sync_at text,
  last_error text,
  PRIMARY KEY (owner_user_id, item_id)
);
```

`0002_create_finance_accounts.sql` (from `AccountRecord`; `shared_to_household` defaults false = "absent means private", FIN-04):

```sql
CREATE TABLE app.finance_accounts (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  item_id text NOT NULL,
  name text NOT NULL,
  official_name text,
  type text NOT NULL,
  subtype text,
  mask text,
  balance_cents bigint NOT NULL,
  iso_currency text NOT NULL,
  updated_at text NOT NULL,
  shared_to_household boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, account_id)
);
```

`0003_index_finance_accounts_item.sql`:

```sql
CREATE INDEX finance_accounts_item_idx ON app.finance_accounts (owner_user_id, item_id);
```

`0004_create_finance_transactions.sql` (from `TransactionRecord`; PK `(owner_user_id, id)` is the F6-D2 idempotency key replacing per-chunk dedup; soft FKs only — `account_id` is a plain column):

```sql
CREATE TABLE app.finance_transactions (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id text NOT NULL,
  account_id text NOT NULL,
  date date NOT NULL,
  amount_cents bigint NOT NULL,
  iso_currency text NOT NULL,
  name text NOT NULL,
  merchant text,
  plaid_category text,
  category_id text,
  pending boolean NOT NULL,
  pending_transaction_id text,
  categorized_by text,
  notes text,
  PRIMARY KEY (owner_user_id, id)
);
```

`0005_index_finance_transactions_account_date.sql` (share projection + sync chunk loads):

```sql
CREATE INDEX finance_transactions_account_date_idx ON app.finance_transactions (owner_user_id, account_id, date DESC);
```

`0006_index_finance_transactions_date.sql` (feed/budget/reports month-window reads):

```sql
CREATE INDEX finance_transactions_date_idx ON app.finance_transactions (owner_user_id, date DESC);
```

`0007_create_finance_balance_snapshots.sql` (from `SnapshotChunk` days; PK = F6-D2 uniqueness `(owner, account, day)`):

```sql
CREATE TABLE app.finance_balance_snapshots (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  account_id text NOT NULL,
  day date NOT NULL,
  balance_cents bigint NOT NULL,
  PRIMARY KEY (owner_user_id, account_id, day)
);
```

`0008_create_finance_budget_assignments.sql` (from `BudgetLedger.assignments`; PK = F6-D2 uniqueness `(owner, month, category)`):

```sql
CREATE TABLE app.finance_budget_assignments (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  month text NOT NULL,
  category_id text NOT NULL,
  assigned_cents bigint NOT NULL,
  PRIMARY KEY (owner_user_id, month, category_id)
);
```

- [ ] **Step 4: Manifest.** In `external-modules/finance/jarvis.module.json`: bump `"version"` to `"0.5.0"` and add (top-level key, alongside `storage`):

```json
"database": {
  "ownedTables": [
    "app.finance_items",
    "app.finance_accounts",
    "app.finance_transactions",
    "app.finance_balance_snapshots",
    "app.finance_budget_assignments"
  ]
}
```

The validator (`packages/module-registry/src/external/validate.ts:447`) already enforces the `app.finance_*` slug prefix — no validator change in this task.

- [ ] **Step 5: Run the test — PASS.** Also run the manifest/registry unit suites so a validation regression surfaces now: `pnpm exec vitest run tests/unit/finance-sql-files.test.ts tests/unit/module-manifest-validate.test.ts` (use the actual validate-test filename; find with `ls tests/unit | grep -i manifest`). If a registry unit test snapshots the finance manifest (version or hash), update it in this task.

- [ ] **Step 6: Commit** `feat(finance): module table DDL + ownedTables manifest (FIN-06a #1166)`.

---

### Task 2: Install integration proof (FIN-06a)

**Files:**

- Create: `tests/integration/finance-tables-install.test.ts`

**Interfaces:**

- Consumes: `installModule` from `scripts/module-install.js` — signature `installModule({ moduleId, manifest, bootstrapConnectionString, migrationConnectionString, migrationsDirectory })` (verified; `manifest` is structural, only `database.ownedTables` is read).

Follow `tests/integration/module-install.test.ts` closely — same imports, same teardown discipline (its REVOKE-before-DROP CASCADE ordering comments explain why; copy the approach, adapted to `finance` role names `jarvis_mod_finance_install` / `jarvis_mod_finance_runtime`).

- [ ] **Step 1: Write the test.** `beforeAll`: `resetEmptyFoundationDatabase()`. Single `it`:

```ts
const result = await installModule({
  moduleId: "finance",
  manifest: {
    database: {
      ownedTables: [
        "app.finance_items",
        "app.finance_accounts",
        "app.finance_transactions",
        "app.finance_balance_snapshots",
        "app.finance_budget_assignments"
      ]
    }
  },
  bootstrapConnectionString: urls.bootstrap,
  migrationConnectionString: urls.bootstrap,
  migrationsDirectory: "external-modules/finance/sql"
});
expect(result.installed).toHaveLength(8);
```

Then assert, via a bootstrap `Client`: (a) all five tables exist in `information_schema.tables`; (b) `relforcerowsecurity` is true for each (`SELECT relname FROM pg_class WHERE relname LIKE 'finance_%' AND relforcerowsecurity`); (c) `app.module_schema_migrations` holds 8 rows for `module_id = 'finance'`; (d) a SECOND `installModule` call with the same arguments installs 0 new files (idempotent re-run: `expect(second.installed).toHaveLength(0)`).

Mirror the connection-string variable names and `migrationConnectionString` choice from `module-install.test.ts` verbatim rather than the sketch above if they differ.

`afterEach`/`afterAll` teardown: DROP the five tables, delete `app.module_installs`/`app.module_schema_migrations` rows for `finance`, revoke + drop both roles with the CASCADE ordering copied from `module-install.test.ts`.

- [ ] **Step 2: Run it:** `pnpm exec tsx scripts/test-integration.ts tests/integration/finance-tables-install.test.ts` — PASS, exit 0.

- [ ] **Step 3: Commit** `test(finance): install integration proof for module tables (FIN-06a #1166)`.

---

### Task 3: Platform seam — `worker.reconcileJobs` (FIN-06b)

**Files:**

- Modify: `packages/module-sdk/src/index.ts` (worker declaration types)
- Modify: `packages/module-registry/src/external/validate.ts`
- Modify: `packages/module-registry/src/external/job-reconciler.ts`
- Test: `tests/unit/module-job-reconciler.test.ts` (extend), validate unit test file (extend)

**Why a platform seam:** `ExternalModuleJobReconciler.reconcileModule` today fans out only cron `schedules` per active user. The spec's "boot reconcile enqueues the job for every owner without the marker" needs a ONE-SHOT enqueue. The generic, module-agnostic form: a manifest `worker.reconcileJobs` list; on every module reconcile, the platform `boss.send`s each declared job once per active user with a singleton key. Dedup is deliberately NOT load-bearing — the handler's marker check makes repeats no-ops (F6-D4).

**Interfaces:**

- Produces: `ExternalModuleReconcileJobDeclaration = { readonly id: string; readonly queue: string; readonly jobKind: string }`, optional `reconcileJobs` array on the manifest worker block. Task 5's manifest entry depends on this exact shape.

- [ ] **Step 1: Failing unit test** — extend `tests/unit/module-job-reconciler.test.ts` (match its existing fake-boss pattern; it already fakes `getSchedules`/`schedule`/`createQueue` etc. — add a `send` recorder):

```ts
it("enqueues manifest reconcileJobs once per active user with a singleton key", async () => {
  // module fixture: one queue "acme.migrate", worker.reconcileJobs =
  //   [{ id: "storage-migrate", queue: "acme.migrate", jobKind: "acme.migrate" }]
  // two active users u1, u2
  await reconciler.reconcileModule("acme");
  expect(sent).toEqual([
    // "/" separator — pg-boss v12 assertKey restricts keys to [\w.\-/] (#1147)
    expect.objectContaining({
      name: "acme.migrate",
      payload: expect.objectContaining({
        actorUserId: "u1",
        jobKind: "acme.migrate",
        moduleId: "acme"
      }),
      options: { singletonKey: "acme/storage-migrate/u1" }
    }),
    expect.objectContaining({ options: { singletonKey: "acme/storage-migrate/u2" } })
  ]);
});
it("skips reconcileJobs whose queue is not declared", async () => {
  /* unknown queue -> no send */
});
```

Also extend the manifest-validate unit test: a manifest with `worker.reconcileJobs` round-trips; entries with unknown keys, a non-declared queue name, or a bad id are rejected.

- [ ] **Step 2: Run — fails** (type + parse + enqueue all missing).

- [ ] **Step 3: Types** in `packages/module-sdk/src/index.ts`, next to the existing schedule declaration types:

```ts
/**
 * #1166 (F6-D4): a job the platform enqueues ONCE PER ACTIVE USER every time
 * the module is reconciled (boot, enable, manifest change). For backfill /
 * repair work. Deliveries repeat across reconciles — handlers MUST be
 * idempotent (marker check); the singletonKey only dedups concurrent sends.
 */
export interface ExternalModuleReconcileJobDeclaration {
  readonly id: string;
  /** Must name one of this module's declared worker queues. */
  readonly queue: string;
  readonly jobKind: string;
}
```

and add `readonly reconcileJobs?: readonly ExternalModuleReconcileJobDeclaration[];` to the worker declaration interface (find it: `grep -n "schedules" packages/module-sdk/src/index.ts`).

- [ ] **Step 4: Validation** in `validate.ts`, next to the schedules block: max 8 entries; `id` must match `/^[a-z0-9][a-z0-9-]{0,63}$/`; `queue` must be one of the declared queue names; `jobKind` non-empty string ≤ 128; reject unknown keys (same style as the neighboring blocks); duplicate `id`s rejected.

- [ ] **Step 5: Enqueue** in `job-reconciler.ts` `reconcileModule`, directly after the schedules loop (reusing `users` and `queueByName`):

```ts
// #1166 F6-D4: one-shot per-user enqueue on every reconcile. "/" separator,
// NOT ":" — pg-boss v12 assertKey restricts keys to [\w.\-/] (#1147 lesson).
// Dedup here is best-effort (concurrent sends only); the real replay guard is
// the handler's idempotency marker.
for (const job of module.manifest.worker?.reconcileJobs ?? []) {
  const queue = queueByName.get(job.queue);
  if (!queue) continue;
  for (const actorUserId of users) {
    const payload: ExternalModuleJobPayload = {
      actorUserId,
      moduleId,
      jobKind: job.jobKind,
      manifestHash: module.manifestHash
    };
    assertModuleJobPayload(queue, payload);
    await this.deps.boss.send(queue.name, payload, {
      singletonKey: `${moduleId}/${job.id}/${actorUserId}`
    });
  }
}
```

- [ ] **Step 6: Run the reconciler + validate unit suites — PASS.** Then `pnpm typecheck`.

- [ ] **Step 7: Commit** `feat(module-registry): worker.reconcileJobs one-shot per-user enqueue (#1166)`.

---

### Task 4: `FinanceStore` port + KV implementation (FIN-06b)

**Files:**

- Create: `external-modules/finance/src/domain/store-port.ts`
- Create: `external-modules/finance/src/domain/store-kv.ts`
- Modify: `external-modules/finance/src/domain/index.ts` (export both)
- Test: `tests/unit/finance-store-kv.test.ts`

**Interfaces:**

- Produces (later tasks depend on these EXACT signatures):

```ts
// external-modules/finance/src/domain/store-port.ts
// FIN-06 (#1166, F6-D3): the storage port both impls satisfy. Vocabulary is
// deliberately the SAME record/chunk shapes handlers use today so the FIN-06c
// cutover is a call-site swap, not a data-model rewrite. Months are "YYYY-MM".
// Domain files never import @jarv1s/* (bundler independence — see kv-port.ts).
import type { AccountRecord, ItemRecord, TransactionRecord } from "./records.js";
import type { BudgetLedger } from "./envelope.js";

export interface FinanceStore {
  listItems(): Promise<ItemRecord[]>;
  getItem(itemId: string): Promise<ItemRecord | null>;
  putItem(record: ItemRecord): Promise<void>;

  listAccounts(): Promise<AccountRecord[]>;
  getAccount(accountId: string): Promise<AccountRecord | null>;
  putAccount(record: AccountRecord): Promise<void>;

  /** Distinct months with transactions, newest first. */
  listTransactionMonths(): Promise<string[]>;
  /** All of one month across accounts, sorted date DESC then id ASC. */
  listMonthTransactions(month: string): Promise<TransactionRecord[]>;
  /** One account's month, same sort; null when empty (KV chunk parity). */
  getTransactionChunk(accountId: string, month: string): Promise<TransactionRecord[] | null>;
  /**
   * Replace one (account, month) window: upsert `records`, prune rows whose
   * id is absent (pending-twin removal / provider removals). Not atomic —
   * both halves are idempotent and re-sync converges (cursor persists last).
   */
  putTransactionChunk(
    accountId: string,
    month: string,
    records: TransactionRecord[]
  ): Promise<void>;
  /** Rewrite a single transaction in place (feed categorize/note paths). */
  putTransaction(record: TransactionRecord): Promise<void>;

  /** Every (accountId, month) snapshot window that exists. */
  listSnapshotChunks(): Promise<{ accountId: string; month: string }[]>;
  /** day (YYYY-MM-DD) -> balanceCents; null when the window is empty. */
  getSnapshotChunk(accountId: string, month: string): Promise<Record<string, number> | null>;
  putSnapshotChunk(accountId: string, month: string, days: Record<string, number>): Promise<void>;

  /** Months that have any assignment row, ascending. */
  listAssignmentMonths(): Promise<string[]>;
  getLedger(month: string): Promise<BudgetLedger | null>;
  /** Sets the TOTAL for one category (FIN-03 replay-safe semantics). */
  setAssignment(month: string, categoryId: string, amountCents: number): Promise<void>;
}
```

- Consumes: `FinanceKv` from `./kv-port.js`, key helpers from `./keys.js` (`itemKey`, `monthKey` — note `monthKey(accountId, isoDate)` takes a full DATE; store-kv builds chunk keys directly as `` `${accountId}:${month}` `` since it holds the month, not a date).

- [ ] **Step 1: Failing tests** in `tests/unit/finance-store-kv.test.ts` against an in-memory `FinanceKv` fake (`Map<string, Map<string, unknown>>` keyed by namespace — copy the fake from the existing finance handler unit tests, e.g. `tests/unit/finance-sync.test.ts`, so seeded shapes match production writes exactly). Cover at minimum:
  - `listItems` returns only `item:*` records from `NS.connections` (a seeded `cursor:i1` and `link:abc` entry must NOT appear).
  - `getTransactionChunk("acc1", "2026-07")` returns the chunk's transactions sorted `date DESC, id ASC` even when seeded unsorted, and `null` when the key is absent.
  - `putTransactionChunk` writes `{ transactions }` under `` `acc1:2026-07` `` in `NS.transactions`, dropping records whose id was pruned from the input.
  - `putTransaction` rewrites exactly one record inside its month chunk (find by `monthKey(record.accountId, record.date)`).
  - `listTransactionMonths` derives distinct months newest-first from chunk keys (`key.split(":")[1]`).
  - `setAssignment` RMWs `ledger:{month}` setting `assignments[categoryId] = amountCents` (total, not delta); `getLedger` returns null for a month with no ledger.
  - `listSnapshotChunks`/`getSnapshotChunk`/`putSnapshotChunk` round-trip `SnapshotChunk.days`.

- [ ] **Step 2: Run — fails** (module not found): `pnpm exec vitest run tests/unit/finance-store-kv.test.ts`

- [ ] **Step 3: Implement `store-kv.ts`.** `export function kvStore(kv: FinanceKv): FinanceStore`. Each method is a faithful extraction of today's handler KV access (the grep map: items = `NS.connections` keys with `item:` prefix; accounts = `NS.accounts` one record per key; transactions/snapshots = `NS.transactions`/`NS.snapshots` chunk per `` `${accountId}:${month}` `` key; ledgers = `NS.budgets` `ledger:{month}`). Sort inside `getTransactionChunk`/`listMonthTransactions` — KV chunks are not order-guaranteed and SQL will sort server-side; the port contract is the sort, so BOTH impls enforce it: `records.sort((a, b) => (a.date === b.date ? (a.id < b.id ? -1 : 1) : a.date < b.date ? 1 : -1))`.

- [ ] **Step 4: Run — PASS.** Then `pnpm typecheck`.

- [ ] **Step 5: Commit** `feat(finance): FinanceStore port + KV implementation (FIN-06b #1166)` (add the three domain files + test explicitly).

---

### Task 5: SQL implementation of `FinanceStore` (FIN-06b)

**Files:**

- Create: `external-modules/finance/src/domain/store-sql.ts`
- Modify: `external-modules/finance/src/domain/index.ts` (export)
- Test: `tests/unit/finance-store-sql.test.ts`

**Interfaces:**

- Produces: `export interface FinanceDb { query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> }` (structural twin of #1167 `ctx.db` — domain must not import the SDK) and `export function sqlStore(db: FinanceDb): FinanceStore`.
- Consumes: table shapes from Task 1. Every statement must pass the #1167 classifier (single statement, no `E''`/`U&`/`set_config`/dollar quotes) and NEVER filters by owner — RLS + `app.current_actor_user_id()` own that.

- [ ] **Step 1: Failing tests** with a fake `FinanceDb` that records `{text, params}` and returns queued rows. Assert the exact SQL text (string equality — these statements ARE the contract) and the row→record mapping: `Number(...)` on every `*_cents` (int8 arrives as string over the RPC), `date`/`day` selected as `::text`. One test per method; plus: `getTransactionChunk` returns `null` on zero rows; `putTransactionChunk` issues upsert-then-prune in that order; month windows use `[first-of-month, first-of-next-month)` — test a December month to pin the year rollover.

- [ ] **Step 2: Run — fails.**

- [ ] **Step 3: Implement.** Core statements (write these verbatim; remaining methods follow the same shapes — full column lists, snake_case→camelCase mapping in one `rowToX` helper per table):

Month window helper (pure):

```ts
// "2026-07" -> ["2026-07-01", "2026-08-01") — half-open so date indexes serve it.
function monthWindow(month: string): { from: string; to: string } {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return { from: `${month}-01`, to: `${next}-01` };
}
```

Transactions read (chunk):

```ts
const TXN_COLUMNS =
  "id, account_id, date::text AS date, amount_cents, iso_currency, name, merchant, " +
  "plaid_category, category_id, pending, pending_transaction_id, categorized_by, notes";
// getTransactionChunk
const { from, to } = monthWindow(month);
const result = await db.query(
  `SELECT ${TXN_COLUMNS} FROM app.finance_transactions ` +
    "WHERE account_id = $1 AND date >= $2 AND date < $3 ORDER BY date DESC, id ASC",
  [accountId, from, to]
);
return result.rows.length === 0 ? null : result.rows.map(rowToTransaction);
```

Transactions write (chunk replace = idempotent upsert + prune):

```ts
// putTransactionChunk — owner_user_id comes from the session GUC, never a param.
for (const record of records) {
  await db.query(
    "INSERT INTO app.finance_transactions (owner_user_id, id, account_id, date, amount_cents, " +
      "iso_currency, name, merchant, plaid_category, category_id, pending, " +
      "pending_transaction_id, categorized_by, notes) " +
      "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) " +
      "ON CONFLICT (owner_user_id, id) DO UPDATE SET account_id = EXCLUDED.account_id, " +
      "date = EXCLUDED.date, amount_cents = EXCLUDED.amount_cents, iso_currency = EXCLUDED.iso_currency, " +
      "name = EXCLUDED.name, merchant = EXCLUDED.merchant, plaid_category = EXCLUDED.plaid_category, " +
      "category_id = EXCLUDED.category_id, pending = EXCLUDED.pending, " +
      "pending_transaction_id = EXCLUDED.pending_transaction_id, " +
      "categorized_by = EXCLUDED.categorized_by, notes = EXCLUDED.notes",
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
const { from, to } = monthWindow(month);
await db.query(
  "DELETE FROM app.finance_transactions WHERE account_id = $1 AND date >= $2 AND date < $3 " +
    "AND NOT (id = ANY($4::text[]))",
  [accountId, from, to, records.map((record) => record.id)]
);
```

(Adjust the record property names to `records.ts` exactly — open it and copy; do not guess optionality.)

Distinct months (index-friendly, no full-row scan):

```ts
// listTransactionMonths
const result = await db.query<{ month: string }>(
  "SELECT DISTINCT left(date::text, 7) AS month FROM app.finance_transactions ORDER BY month DESC"
);
return result.rows.map((row) => row.month);
```

Assignments:

```ts
// setAssignment — replay-safe: SETS the total (FIN-03 contract).
await db.query(
  "INSERT INTO app.finance_budget_assignments (owner_user_id, month, category_id, assigned_cents) " +
    "VALUES (app.current_actor_user_id(), $1, $2, $3) " +
    "ON CONFLICT (owner_user_id, month, category_id) DO UPDATE SET assigned_cents = EXCLUDED.assigned_cents",
  [month, categoryId, amountCents]
);
// getLedger
const result = await db.query<{ category_id: string; assigned_cents: string | number }>(
  "SELECT category_id, assigned_cents FROM app.finance_budget_assignments WHERE month = $1",
  [month]
);
if (result.rows.length === 0) return null;
const assignments: Record<string, number> = {};
for (const row of result.rows) assignments[row.category_id] = Number(row.assigned_cents);
return { assignments };
```

Snapshots follow the same pattern (`day::text AS day`; upsert `ON CONFLICT (owner_user_id, account_id, day) DO UPDATE SET balance_cents = EXCLUDED.balance_cents`; `listSnapshotChunks` = `SELECT DISTINCT account_id, left(day::text, 7) AS month FROM app.finance_balance_snapshots ORDER BY account_id, month`). Items/accounts are single-row upserts on their PKs with full-column `DO UPDATE SET` (same style as transactions), reads `SELECT <cols> FROM ... [WHERE item_id/account_id = $1]` with `updated_at`/`connected_at` passed through as text.

- [ ] **Step 4: Run — PASS**, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(finance): SQL FinanceStore over module db.query (FIN-06b #1166)`.

---

### Task 6: Manifest wiring, store selector, `finance.storage-migrate` handler (FIN-06b)

**Files:**

- Modify: `external-modules/finance/jarvis.module.json`
- Modify: `external-modules/finance/src/domain/kv-port.ts` (add `meta` to `NS`)
- Create: `external-modules/finance/src/worker/store.ts`
- Create: `external-modules/finance/src/worker/handlers/migrate.ts`
- Modify: `external-modules/finance/src/worker/ports.ts` + `index.ts` + registry (wherever `finance.share-apply` is registered — mirror that registration pattern for `finance.storage-migrate`)
- Test: `tests/unit/finance-storage-migrate.test.ts`, `tests/unit/finance-store-select.test.ts`

**Interfaces:**

- Consumes: Task 3's `reconcileJobs` manifest key; Task 4/5 stores; `ctx.db` read structurally like `ctx.ai` in `ports()` (older-host degradation — see how `MaybeAiContext` is handled in `worker/index.ts`).
- Produces: `ports.store: () => Promise<FinanceStore>` (async selector, memoized per invocation) and `MIGRATED_MARKER_KEY = "storage:migrated"` in `NS.meta`.

- [ ] **Step 1: Manifest.** Add namespace `{ "namespace": "finance.meta", "scopes": ["user"] }` (copy the exact object shape of the existing user-scoped namespace entries); queue `{ "name": "finance.storage-migrate", "jobKind": "finance.storage-migrate" }` (copy the share-apply queue entry's exact shape, minus any paramsSchema — this job takes NO params, payload is pure metadata per F6-D4); and:

```json
"reconcileJobs": [
  { "id": "storage-migrate", "queue": "finance.storage-migrate", "jobKind": "finance.storage-migrate" }
]
```

inside the `worker` block. Add `meta: "finance.meta"` to `NS` in `kv-port.ts`.

- [ ] **Step 2: Failing selector tests** (`finance-store-select.test.ts`): given fake kv + fake db — (a) no marker → KV store even when db present; (b) marker present + db present → SQL store; (c) marker present but NO db (older host) → KV store; (d) marker is read from KV at most once per created selector (memoized — count kv.get calls).

- [ ] **Step 3: Implement `worker/store.ts`:**

```ts
// FIN-06b (#1166 F6-D4): the ONLY dual-read point in the module. Everything
// else asks the selector and gets one store for the whole invocation.
import { kvStore, sqlStore, type FinanceDb, type FinanceStore } from "../domain/index.js";
import { NS, type FinanceKv } from "../domain/kv-port.js";

export const MIGRATED_MARKER_KEY = "storage:migrated";

export function storeSelector(
  kv: FinanceKv,
  db: FinanceDb | undefined
): () => Promise<FinanceStore> {
  let selected: Promise<FinanceStore> | undefined;
  return () => {
    selected ??= (async () => {
      // Older hosts have no ctx.db — stay on KV regardless of the marker so
      // a marked owner still degrades to their (already deleted) KV... which
      // is why the marker is only written by the migrate handler AFTER it has
      // confirmed db access: marker implies db existed at migrate time.
      if (db === undefined) return kvStore(kv);
      const marker = await kv.get(NS.meta, MIGRATED_MARKER_KEY);
      return marker ? sqlStore(db) : kvStore(kv);
    })();
    return selected;
  };
}
```

In `ports.ts`/`index.ts`: read `const db = (ctx as { db?: FinanceDb }).db` structurally (same pattern as `MaybeAiContext`), add `store: storeSelector(kv, db)` to the ports object, and thread the type through the `FinancePorts` interface.

- [ ] **Step 4: Failing migrate-handler tests** (`finance-storage-migrate.test.ts`, fake kv + fake db): (a) happy path copies every item/account/transaction/snapshot-day/assignment from KV to inserts, verifies counts, writes the marker, THEN deletes the migrated KV keys (assert call order: last insert < marker set < first delete); (b) replay with marker already set → no-op, zero db calls; (c) count-verify mismatch (fake db returns a short count) → throws, NO marker written, NO KV deleted; (d) rules/prefs/cursors/`link:*`/`finance.shared` keys are untouched; (e) `state:{month}` cache keys are DELETED but never copied (F6-D1).

- [ ] **Step 5: Implement `handlers/migrate.ts`.** Handler shape mirrors the other queue handlers (host envelope `{actorUserId, jobKind, idempotencyKey, params}` — it ignores `params` entirely). Flow, in order:
  1. If `await kv.get(NS.meta, MIGRATED_MARKER_KEY)` → return `{ status: "already-migrated" }` (idempotent replay guard — this is why reconcile re-delivery is harmless).
  2. If `db === undefined` → throw a domain error (`FinanceKvError("storage_unavailable", ...)` style) — the platform retries later; never mark.
  3. Read every KV source: `item:*` records + accounts + transaction chunks + snapshot chunks + `ledger:*`; insert through the Task 5 SQL statements but with `ON CONFLICT ... DO NOTHING` variants (crash-replay safe: a re-run must not clobber rows a later sync already updated — write a small local `insertIgnore` set of statements in this file, same column lists, `DO NOTHING` instead of `DO UPDATE`).
  4. Count-verify per table: `SELECT count(*)::int AS n FROM app.finance_transactions` etc. must be ≥ the number of records read from KV (≥, not =: a concurrent sync may have added rows). Mismatch → throw, nothing marked or deleted.
  5. Write the marker: `kv.set(NS.meta, MIGRATED_MARKER_KEY, { migratedAt: iso(now()) })` (use the ports `now` — no ambient dates; the check:no-ambient-dates gate enforces this).
  6. Delete migrated keys ONLY: the copied `item:*` keys, all `NS.accounts` keys, all `NS.transactions` chunk keys, all `NS.snapshots` chunk keys, all `ledger:*` AND all `state:*` keys in `NS.budgets` (cache dies here, F6-D1). Leave `cursor:*`, `link:*`, rules, categories, settings, and the `finance.shared` instance mirror alone.
     Return `{ status: "migrated", counts: { items, accounts, transactions, snapshotDays, assignments } }` (counts are numbers — metadata, not content).

- [ ] **Step 6: Register** the handler for queue `finance.storage-migrate` exactly where/how `finance.share-apply` registers its handler. Run both new unit files + `pnpm typecheck` — PASS.
- [ ] **Step 7: Commit** `feat(finance): storage-migrate backfill + per-owner store selector (FIN-06b #1166)`.

---

### Task 7: Migrate-handler integration proof (FIN-06b)

**Files:**

- Create: `tests/integration/finance-storage-migrate.test.ts`

**Interfaces:**

- Consumes: Task 2's install fixture pattern (install the REAL `external-modules/finance/sql` migrations into the test DB, finance role names), `createModuleStorageRpc` + `DataContextRunner` (see `tests/integration/module-storage-rpc.test.ts` for the exact setup), the real module-KV storage layer used by other finance integration tests (grep `tests/integration` for how module KV rows are seeded — follow that pattern, do NOT hand-insert into `app.module_kv` unless that is what existing tests do).

- [ ] **Step 1: Write the test.** Setup: reset foundation DB, run `installModule` (real manifest tables, as Task 2), grant runtime role to `jarvis_app_runtime` (as `module-storage-rpc.test.ts:41`). Seed owner A's KV with a small realistic dataset (2 items, 3 accounts, 2 months × transactions incl. one pending pair, snapshot days, one ledger, one `state:` cache row, plus one `cursor:*` and one rule that must survive). Build the module's real `FinanceKv`/store objects over the real backing, wire `db` = `createModuleStorageRpc(scopedDb, "finance")` adapted to `FinanceDb`, and invoke the real migrate handler.
      Assert: (a) SQL row counts match seeds; (b) marker present in `finance.meta`; (c) migrated KV keys gone, `cursor:*` + rule + `state:` gone-vs-kept exactly per Task 6 step 6; (d) second invocation returns `already-migrated` with zero new rows; (e) a DIFFERENT owner B with KV data and no marker sees owner A's rows not at all (`sqlStore(db).listAccounts()` under B's data context returns only B's rows — RLS proof at the store level); (f) crash-replay: seed owner C, run a migrate whose db fake... (no — this is the REAL db; simulate crash by deleting the marker after a full run and re-invoking: ON CONFLICT DO NOTHING absorbs every duplicate, counts still verify, marker rewritten).

- [ ] **Step 2: Run:** `pnpm exec tsx scripts/test-integration.ts tests/integration/finance-storage-migrate.test.ts` — PASS exit 0.
- [ ] **Step 3: Commit** `test(finance): storage-migrate integration proof — replay, RLS, selective KV cleanup (FIN-06b #1166)`.

---

### Task 8: Cutover — connect, accounts, sync (FIN-06c)

**Files:**

- Modify: `external-modules/finance/src/worker/handlers/connect.ts`, `accounts.ts`, `sync.ts`
- Test: their existing unit test files (update construction only)

**Interfaces:**

- Consumes: `ports.store(): Promise<FinanceStore>` from Task 6. Rule for ALL cutover tasks: every read/write of items (`item:*`), accounts, transaction chunks, snapshot chunks, and `ledger:*` goes through `const store = await ports.store()` (call once at handler top). KV stays ONLY for: cursors (`cursor:*`), link sessions (`link:*`), settings, rules, categories, and the `finance.shared` instance mirror.

- [ ] **Step 1: Update unit tests first.** Handler tests construct ports with a fake kv today; add `store: () => Promise.resolve(kvStore(fakeKv))` so every existing seed/assertion keeps working verbatim — that equivalence IS the test that cutover changed no behavior. Run them: they FAIL only on the missing `store` port type until Step 2 lands, then must pass unchanged.

- [ ] **Step 2: Cutover call sites** (line refs from the pre-plan grep; re-locate by content if drifted):
  - `connect.ts`: `:149` account upsert → `store.putAccount(record)`; `:157` item write → `store.putItem(item)`; the `:59-63` connection listing keeps its KV iteration ONLY for `link:*`/`cursor:*` concerns — item enumeration becomes `store.listItems()`. Link-session RMW `:161-200` stays KV untouched.
  - `accounts.ts`: `:104-119` list+get loop → `store.listAccounts()` (one call; keep the `:139` stable-sort comment and sort); `:111` item status lookup → `store.getItem(itemId)`.
  - `sync.ts`: `:110/:216` cursor read/write stay KV. `:122-129` snapshot chunk RMW → `store.getSnapshotChunk(accountId, month)` / `store.putSnapshotChunk(...)` (parse `accountId`/`month` from the same `monthKey` string the reducer already builds: `const [accountId, month] = key.split(":")`). `:154-162` account RMW → `store.getAccount`/`store.putAccount`. `:190-197` transaction chunk RMW → `store.getTransactionChunk`/`store.putTransactionChunk` with the same key split. `:244` → `store.getAccount`. `:279/:306/:319` item status writes → `store.putItem`.

- [ ] **Step 3: Run the three unit files + `pnpm typecheck` — all PASS with assertions unchanged.**
- [ ] **Step 4: Commit** `feat(finance): connect/accounts/sync on FinanceStore (FIN-06c #1166)`.

---

### Task 9: Cutover — feed, shared, reports (FIN-06c)

**Files:**

- Modify: `external-modules/finance/src/worker/handlers/feed.ts`, `shared.ts`, `reports.ts`
- Test: their existing unit test files (same `store: () => Promise.resolve(kvStore(fakeKv))` move as Task 8)

- [ ] **Step 1: Tests first** — same pattern as Task 8 Step 1.
- [ ] **Step 2: Cutover:**
  - `feed.ts`: taxonomy (`:39`) and rules (`:177`) stay KV. Month read `:64-68` → `store.listMonthTransactions(month)` when a month is given, else `store.listTransactionMonths()` then concat `listMonthTransactions` per month (preserve the existing merge/sort at `:104` — the port already returns the pinned order, so the local sort becomes a no-op safety net; keep it). Categorize/note rewrite `:147/:166/:201` — replace the whole chunk-RMW with `store.putTransaction(updated)` after locating the record via `store.getTransactionChunk(accountId, month)`.
  - `shared.ts`: `:40/:48` → `store.getAccount`/`store.putAccount` (mirror writes to `finance.shared` stay on the instance KV port). `:58-60` account's chunks → `store.listTransactionMonths()` + `store.getTransactionChunk(accountId, month)`, skipping nulls.
  - `reports.ts`: `:50-52` → months + `listMonthTransactions`; `:97-98` → `store.listAccounts()`; `:106-107` → `store.listSnapshotChunks()` + `getSnapshotChunk`.
- [ ] **Step 3: Run the three unit files + typecheck — PASS unchanged.**
- [ ] **Step 4: Commit** `feat(finance): feed/shared/reports on FinanceStore (FIN-06c #1166)`.

---

### Task 10: Cutover — budget + delete the `state:` cache (FIN-06c)

**Files:**

- Modify: `external-modules/finance/src/worker/handlers/budget.ts`
- Test: its unit test file

**Why the cache dies:** F6-D1 — `state:{YYYY-MM}` was a KV-read-amplification workaround. SQL month reads are one indexed query; status now always computes from `loadBudgetInputs`. This also retires the FIN-03 invalidate/warm write-path machinery (No Stale Concepts rule: remove the vocabulary in the same pass).

- [ ] **Step 1: Tests.** Add `store` to the fake ports as in Task 8. DELETE the tests that assert cache warm/invalidate/hit behavior; KEEP (and they must still pass) every derivation and assignment-semantics test: rollover, TBB, assign-sets-total, replay.
- [ ] **Step 2: Cutover + removal:** `:83-86` ledger listing → `store.listAssignmentMonths()` + `store.getLedger(month)`; `:90-93` → `store.listTransactionMonths()` + `store.listMonthTransactions(month)`; `:147-151` assignment RMW → `store.setAssignment(args.month, args.categoryId, args.amountCents)`. Remove `stateKey` (`:47`), the `state:` sweep helper (`:58-67`), the cached-read at `:127`, and every warm call — `finance.budget.status` computes unconditionally. `ledgerKey` (`:46`) survives only if the migrate handler imports it; otherwise inline it there and delete here.
- [ ] **Step 3: Run budget unit file + typecheck — derivation assertions PASS unchanged.** Grep check: `grep -rn "state:" external-modules/finance/src` returns ONLY the migrate handler's deletion sweep.
- [ ] **Step 4: Commit** `feat(finance): budget on FinanceStore, retire state cache (FIN-06c #1166)`.

---

### Task 11: UAT — ETL proof on a real instance (FIN-06c)

**Files:**

- Modify: `tests/uat/specs/finance-reports.uat.spec.ts` (KV-gone assertion)

**The proof (F6-D5):** seeds stay KV-shaped and are NOT touched. On module enable, reconcile fires `finance.storage-migrate` per owner (Task 3 seam); the four finance specs then pass with the SAME dollar figures as before — that is the end-to-end ETL correctness proof.

- [ ] **Step 1: Add the assertion** to `finance-reports.uat.spec.ts`, after the existing report assertions: poll (retry ≤60s, 2s interval — the migrate job is async after enable) the UAT DB via the spec's existing docker-exec-psql diagnostic helper pattern (see its afterEach — same `docker ... exec -T postgres psql -U postgres -d jarv1s -c` invocation), asserting ALL of:
  - `SELECT count(*) FROM app.module_kv WHERE module_id = 'finance' AND namespace IN ('finance.accounts','finance.transactions','finance.snapshots')` → 0
  - `... namespace = 'finance.connections' AND key LIKE 'item:%'` → 0
  - `... namespace = 'finance.budgets'` → 0 (ledger AND state both gone)
  - `SELECT count(*) FROM app.finance_transactions` → > 0 (rows actually landed)
    (Adjust namespace strings/column names to the real `NS` values and `app.module_kv` columns — verify with one manual psql against the UAT stack before finalizing.)
- [ ] **Step 2: Playwright 1.60 traps** (durable, from memory): afterEach fixture arg MUST be `async ({}, testInfo)` with `// eslint-disable-next-line no-empty-pattern`; collection check: `npx playwright test --config=tests/uat/playwright.uat.config.ts --list tests/uat/specs/finance-reports.uat.spec.ts` with dummy JARVIS_UAT_BASE_URL/PROJECT_NAME.
- [ ] **Step 3: Run all four specs on a REBUILT image** (`JARVIS_UAT_BUILD=1`): finance-reports, finance-feed, finance-budget, finance-shared. All green; dollar figures unchanged from the FIN-05 record (net worth $14,543.17 carry-forward, groceries $115.68/$84.32, TBB −$2,050.00). finance-shared run-1 strict-mode "Enable Finance" locator race is a known flake — rerun once before investigating.
- [ ] **Step 4: Commit** `test(finance): UAT ETL proof — KV drained into tables, figures unchanged (FIN-06c #1166)`.

---

### Task 12: Gate, PR, merge

- [ ] **Step 1: Full 12-stage gate**, piecewise FOREGROUND, each <600s, real exit codes (never pipe the run into `tail`): lint → format:check → check:file-size → check:design-tokens → check:no-ambient-dates → check:package-deps → typecheck → build:app-map → test:unit → create throwaway DB `jarvis_fin06_gate` (tmp tsx script inside the repo; delete after) then `JARVIS_PGDATABASE=jarvis_fin06_gate pnpm db:migrate` → test:uat-seed → integration in 8 round-robin batches (`ls tests/integration/*.test.ts | split -n r/8`, each `JARVIS_PGDATABASE=jarvis_fin06_gate pnpm exec tsx scripts/test-integration.ts $(cat batch)`). Drop the DB after. Record every stage's exit code and counts.
- [ ] **Step 2: PR** to main: title `feat(finance): module-owned tables + KV backfill (FIN-06)`, body: "Closes #1166", the user-facing line "Not user-visible: finance storage now uses module-owned tables; screens and tools behave identically.", full gate record, UAT record (four specs + timings), security summary (owner column from session GUC, platform RLS, metadata-only migrate payloads, redaction unchanged), trailer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 3: merge.** Poll `gh pr checks` until ALL checks green including verify-foundation, then `gh pr merge --squash`. Report merge sha. (`NEVER --auto` superseded by #895: once the `CI gate` required-status-check ruleset is applied to `main`, `--auto` is safe — GitHub then holds the merge for the required check instead of merging immediately. Until the ruleset lands, keep polling manually.)

---

## Self-Review Notes (spec ↔ plan)

- F6-D1 namespace disposition: items/accounts/transactions/snapshots/ledgers → Tasks 1/4/5/6; `state:` deleted (Tasks 6+10); shared/rules/prefs/cursors/link stay KV (Tasks 6 step 6, 8, 9). ✔
- F6-D2 owner column + platform RLS + uniqueness + soft FKs → Task 1 DDL, Task 2 `relforcerowsecurity` proof. ✔
- F6-D3 SQL reads via ctx.db, pure domain kept → Task 5 (statements), Tasks 8–10 (handlers keep domain functions, swap I/O). ✔
- F6-D4 idempotent per-owner job, marker-last, metadata-only payload, boot enqueue, dual-read only in the port → Tasks 3/6/7. ✔
- F6-D5 KV seeds unchanged + 4 specs + KV-gone → Task 11. ✔
- Type-consistency: `FinanceStore` signatures in Task 4 are the ones consumed verbatim in Tasks 5–10; `FinanceDb` structural twin of #1167 `ctx.db`. ✔
