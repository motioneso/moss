import { randomUUID } from "node:crypto";
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
import {
  sqlStore,
  DEFAULT_CATEGORIES,
  type BudgetChange,
  type BudgetReview,
  type FinanceDb,
  type ManualAccountCreate,
  type ReconciliationFinish,
  type ImportApply,
  type ManualEntryCreate
} from "../../external-modules/finance/src/domain/index.js";
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
const account = (over: Partial<ManualAccountCreate> = {}): ManualAccountCreate => ({
  accountId: `manual:${randomUUID()}`,
  name: "Synthetic checking",
  type: "depository",
  subtype: "checking",
  isoCurrency: "USD",
  openingDate: "2026-10-01",
  openingBalanceCents: 100000,
  digest: "a".repeat(64),
  at: "2026-10-28T00:00:00Z",
  ...over
});
const entry = (accountId: string, over: Partial<ManualEntryCreate> = {}): ManualEntryCreate => ({
  id: `manual:${randomUUID()}`,
  accountId,
  name: "Synthetic purchase",
  date: "2026-10-02",
  amountCents: 8243,
  isoCurrency: "USD",
  categoryId: "groceries",
  notes: "Synthetic private note",
  cleared: false,
  digest: "b".repeat(64),
  at: "2026-10-28T00:00:00Z",
  ...over
});
const statement = (
  accountId: string,
  over: Partial<ReconciliationFinish> = {}
): ReconciliationFinish => ({
  id: `manual:${randomUUID()}`,
  accountId,
  statementDate: "2026-10-10",
  balanceCents: 100000,
  isoCurrency: "USD",
  expectedRevision: 0,
  selectedIds: [],
  digest: "e".repeat(64),
  at: "2026-10-28T00:00:00Z",
  ...over
});
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
describe("manual ledger through installed module SQL and actual owner role", () => {
  it("creates one baseline without inventing income; replay preserves it", async () => {
    const a = account();
    expect(await owner((s) => s.manual!.createAccount(a))).toBe("created");
    expect(await owner((s) => s.manual!.createAccount(a))).toBe("unchanged");
    expect(await owner((s) => s.manual!.createAccount({ ...a, digest: "c".repeat(64) }))).toBe(
      "conflict"
    );
    expect(await owner((s) => s.getAccount(a.accountId))).toMatchObject({
      source: "manual",
      itemId: null,
      balanceCents: 100000,
      openingBalanceCents: 100000,
      openingDate: "2026-10-01"
    });
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toBeNull();
  });
  it("races identical and different entries without doubling or losing cents", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const spend = entry(a.accountId);
    const same = await Promise.all([
      owner((s) => s.manual!.createEntry(spend)),
      owner((s) => s.manual!.createEntry(spend))
    ]);
    expect(same.sort()).toEqual(["created", "unchanged"]);
    const refund = entry(a.accountId, { amountCents: -123, digest: "c".repeat(64) });
    const income = entry(a.accountId, { amountCents: -12000, digest: "d".repeat(64) });
    expect(
      await Promise.all([
        owner((s) => s.manual!.createEntry(refund)),
        owner((s) => s.manual!.createEntry(income))
      ])
    ).toEqual(["created", "created"]);
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(103880);
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toHaveLength(3);
    const events = await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 100));
    expect(events.filter((event) => event.params.accountId === a.accountId)).toHaveLength(4);
    expect(JSON.stringify(events)).not.toContain("Synthetic private note");
  });
  it("keeps owner records unavailable and validates date/currency before balance movement", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    expect(await owner((s) => s.manual!.createEntry(entry(a.accountId)), ids.userB)).toBe(
      "unavailable"
    );
    expect(await owner((s) => s.getAccount(a.accountId), ids.userB)).toBeNull();
    expect(
      await owner((s) => s.manual!.createEntry(entry(a.accountId, { date: "2026-09-30" })))
    ).toBe("invalid_date");
    expect(
      await owner((s) => s.manual!.createEntry(entry(a.accountId, { isoCurrency: "EUR" })))
    ).toBe("unavailable");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(
      a.openingBalanceCents
    );
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toBeNull();
  });
  it("uses debt signs and refuses overflow without a transaction or activity", async () => {
    const debt = account({ type: "credit", subtype: "credit card" });
    await owner((s) => s.manual!.createAccount(debt));
    await owner((s) => s.manual!.createEntry(entry(debt.accountId)));
    expect((await owner((s) => s.getAccount(debt.accountId)))?.balanceCents).toBe(108243);
    const max = account({ openingBalanceCents: Number.MAX_SAFE_INTEGER });
    await owner((s) => s.manual!.createAccount(max));
    expect(
      await owner((s) => s.manual!.createEntry(entry(max.accountId, { amountCents: -1 })))
    ).toBe("overflow");
    expect(await owner((s) => s.getTransactionChunk(max.accountId, "2026-10"))).toBeNull();
    expect(
      (await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 100))).filter(
        (event) => event.params.accountId === max.accountId
      )
    ).toHaveLength(1);
  });
  it("preserves manual balances during stale sharing updates and provider upserts", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const stale = (await owner((s) => s.getAccount(a.accountId)))!;
    const e = entry(a.accountId);
    await owner((s) => s.manual!.createEntry(e));
    await owner((s) => s.putAccount({ ...stale, sharedToHousehold: true }));
    await owner((s) =>
      s.putAccount({ ...stale, source: undefined, itemId: "synthetic-provider", balanceCents: 2 })
    );
    const persisted = (await owner((s) => s.getAccount(a.accountId)))!;
    expect(persisted).toMatchObject({
      source: "manual",
      itemId: null,
      balanceCents: 91757,
      sharedToHousehold: true
    });
    const tx = (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))![0]!;
    await owner((s) => s.putTransaction({ ...tx, source: undefined, amountCents: 999999 }));
    await owner((s) => s.putTransactionChunk(a.accountId, "2026-10", []));
    expect(
      (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))![0]!.amountCents
    ).toBe(8243);
  });
  it("reconciles an exact selected statement once and carries outstanding entries forward", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const expense = entry(a.accountId, { cleared: true });
    const refund = entry(a.accountId, { amountCents: -123, digest: "c".repeat(64) });
    await owner((s) => s.manual!.createEntry(expense));
    await owner((s) => s.manual!.createEntry(refund));
    const view = await owner((s) => s.reconciliation!.read(a.accountId, "2026-10-10"));
    expect(view).toMatchObject({
      baselineCents: 100000,
      recordedCents: 91880,
      revision: 2,
      totalEntries: 2
    });
    const finish = statement(a.accountId, {
      expectedRevision: 2,
      balanceCents: 91757,
      selectedIds: [expense.id]
    });
    expect(await owner((s) => s.reconciliation!.finish(finish))).toBe("created");
    expect(await owner((s) => s.reconciliation!.finish(finish))).toBe("unchanged");
    expect(
      await owner((s) => s.reconciliation!.finish({ ...finish, digest: "f".repeat(64) }))
    ).toBe("conflict");
    expect(await owner((s) => s.reconciliation!.finish(finish), ids.userB)).toBe("conflict");
    expect(
      await owner((s) => s.reconciliation!.read(a.accountId, "2026-10-10"), ids.userB)
    ).toBeNull();
    const after = await owner((s) => s.reconciliation!.read(a.accountId, "2026-10-11"));
    expect(after).toMatchObject({
      baselineCents: 91757,
      recordedCents: 91880,
      revision: 3,
      totalEntries: 1,
      lastReconciledDate: "2026-10-10"
    });
    expect(after!.entries[0]?.id).toBe(refund.id);
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(91880);
    const rows = await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"));
    expect(rows?.find((r) => r.id === expense.id)?.reconciledAt).toBeTruthy();
    expect(rows?.find((r) => r.id === refund.id)?.reconciledAt).toBeNull();
    const reconciled = rows!.find((r) => r.id === expense.id)!;
    await owner((s) =>
      s.putTransaction({
        ...reconciled,
        categoryId: "dining",
        notes: "Updated private note",
        amountCents: 1,
        date: "2026-10-28",
        cleared: false,
        reconciledAt: null
      })
    );
    const edited = (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))!.find(
      (r) => r.id === expense.id
    )!;
    expect(edited).toMatchObject({
      categoryId: "dining",
      notes: "Updated private note",
      amountCents: expense.amountCents,
      date: expense.date,
      cleared: true,
      reconciledAt: reconciled.reconciledAt
    });
    expect(await owner((s) => s.manual!.createEntry(entry(a.accountId)))).toBe("reconciled_period");
    expect(
      await owner((s) =>
        s.reconciliation!.finish(
          statement(a.accountId, {
            statementDate: "2026-10-11",
            expectedRevision: 3,
            balanceCents: 91880,
            selectedIds: [refund.id]
          })
        )
      )
    ).toBe("created");
    const events = await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 100));
    expect(
      events.filter((e) => e.kind === "account.reconcile" && e.params.accountId === a.accountId)
    ).toHaveLength(2);
  });
  it("rejects mismatched, stale, foreign and incomplete selections without partial reconciliation", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const expense = entry(a.accountId, { cleared: true });
    await owner((s) => s.manual!.createEntry(expense));
    const valid = statement(a.accountId, {
      expectedRevision: 1,
      balanceCents: 91757,
      selectedIds: [expense.id]
    });
    const invalid: Partial<ReconciliationFinish>[] = [
      { balanceCents: 91758 },
      { expectedRevision: 0 },
      { isoCurrency: "EUR" },
      { selectedIds: [expense.id, "foreign"] },
      { selectedIds: [expense.id, expense.id] },
      { statementDate: "2026-10-01" },
      { statementDate: "2026-09-30", selectedIds: [], balanceCents: 100000 }
    ];
    for (const change of invalid)
      expect(await owner((s) => s.reconciliation!.finish({ ...valid, ...change }))).toBe(
        "conflict"
      );
    const view = await owner((s) => s.reconciliation!.read(a.accountId, "2026-10-10"));
    expect(view).toMatchObject({ lastReconciledDate: null, revision: 1, totalEntries: 1 });
    expect(
      (await owner((s) => s.getTransactionChunk(a.accountId, "2026-10")))?.[0]?.reconciledAt
    ).toBeNull();
  });
  it("handles debt and unchecked entries without changing the recorded account balance", async () => {
    const a = account({ type: "credit", subtype: "credit card" });
    await owner((s) => s.manual!.createAccount(a));
    const charge = entry(a.accountId, { cleared: true });
    const payment = entry(a.accountId, { amountCents: -12000, cleared: true });
    await owner((s) => s.manual!.createEntry(charge));
    await owner((s) => s.manual!.createEntry(payment));
    expect(
      await owner((s) =>
        s.reconciliation!.finish(
          statement(a.accountId, {
            expectedRevision: 2,
            selectedIds: [payment.id],
            balanceCents: 88000
          })
        )
      )
    ).toBe("created");
    const rows = await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"));
    expect(rows?.find((r) => r.id === charge.id)).toMatchObject({
      cleared: false,
      reconciledAt: null
    });
    expect(rows?.find((r) => r.id === payment.id)?.reconciledAt).toBeTruthy();
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(96243);
  });
  it("serializes concurrent finish replays and competing statements", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const finish = statement(a.accountId);
    const same = await Promise.all([
      owner((s) => s.reconciliation!.finish(finish)),
      owner((s) => s.reconciliation!.finish(finish))
    ]);
    expect(same.sort()).toEqual(["created", "unchanged"]);
    const b = account();
    await owner((s) => s.manual!.createAccount(b));
    const distinct = await Promise.all([
      owner((s) => s.reconciliation!.finish(statement(b.accountId))),
      owner((s) => s.reconciliation!.finish(statement(b.accountId)))
    ]);
    expect(distinct.sort()).toEqual(["conflict", "created"]);
  });
  it("races a new posting against statement finish without reconciling a stale ledger", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const results = await Promise.all([
      owner((s) => s.manual!.createEntry(entry(a.accountId))),
      owner((s) => s.reconciliation!.finish(statement(a.accountId)))
    ]);
    expect([
      ["created", "conflict"],
      ["reconciled_period", "created"]
    ]).toContainEqual(results);
  });
  it("counts the complete statement and refuses a truncated 501-entry review", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    await runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query(
        `WITH inserted AS (
        INSERT INTO app.finance_transactions
          (owner_user_id, id, account_id, date, name, amount_cents, iso_currency, pending, categorized_by, source, entry_digest)
        SELECT app.current_actor_user_id(), 'limit-' || g::text, $1, '2026-10-02'::date,
          'Synthetic volume entry', 1, 'USD', false, 'user', 'manual', repeat('a', 64)
        FROM generate_series(1, 501) g RETURNING amount_cents
      ) UPDATE app.finance_accounts SET balance_cents = balance_cents - (SELECT sum(amount_cents) FROM inserted),
          ledger_revision = 501 WHERE account_id = $1`,
        [a.accountId]
      );
    });
    const view = await owner((s) => s.reconciliation!.read(a.accountId, "2026-10-10"));
    expect(view).toMatchObject({ totalEntries: 501, recordedCents: 99499, revision: 501 });
    expect(view!.entries).toHaveLength(500);
    expect(
      await owner((s) =>
        s.reconciliation!.finish(statement(a.accountId, { expectedRevision: 501 }))
      )
    ).toBe("conflict");
  });
});

describe("atomic CSV imports through installed SQL", () => {
  const batch = (accountId: string, over: Partial<ImportApply> = {}): ImportApply => ({
    id: `manual:${randomUUID()}`,
    accountId,
    isoCurrency: "USD",
    expectedRevision: 0,
    rows: [
      {
        sourceRow: 1,
        date: "2026-10-02",
        name: "Synthetic import market",
        amountCents: 123,
        notes: "Synthetic imported private note",
        allowDuplicate: false
      },
      {
        sourceRow: 3,
        date: "2026-10-03",
        name: "Synthetic refund",
        amountCents: -456,
        notes: "",
        allowDuplicate: false
      }
    ],
    cleared: true,
    digest: "1".repeat(64),
    at: "2026-10-28T00:00:00Z",
    ...over
  });
  it("imports every row once, retains source identities and replays after later ledger changes", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const b = batch(a.accountId);
    expect(await owner((s) => s.imports!.apply(b))).toBe("created");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(100333);
    const rows = await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"));
    expect(rows?.map((r) => r.id).sort()).toEqual([`${b.id}:1`, `${b.id}:3`]);
    expect(
      rows?.every(
        (r) =>
          r.source === "manual" &&
          r.cleared &&
          r.categoryId === null &&
          r.reviewState === "needs_look"
      )
    ).toBe(true);
    await owner((s) => s.manual!.createEntry(entry(a.accountId)));
    expect(await owner((s) => s.imports!.apply(b))).toBe("unchanged");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(92090);
    expect(await owner((s) => s.imports!.apply({ ...b, digest: "2".repeat(64) }))).toBe("conflict");
    const events = await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 200));
    expect(
      events.filter((e) => e.kind === "transaction.import" && e.params.importId === b.id)
    ).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain("Synthetic imported private note");
  });
  it("marks both file and ledger duplicates and requires explicit import decisions", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    await owner((s) =>
      s.manual!.createEntry(
        entry(a.accountId, { name: " Synthetic  IMPORT market ", amountCents: 123 })
      )
    );
    const b = batch(a.accountId, { expectedRevision: 1 });
    b.rows.push({ ...b.rows[0]!, sourceRow: 4 });
    expect((await owner((s) => s.imports!.preview(a.accountId, b.rows)))?.duplicateRows).toEqual([
      1, 4
    ]);
    expect(await owner((s) => s.imports!.apply(b))).toBe("conflict");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(99877);
    const reviewed = { ...b, rows: [{ ...b.rows[0]!, allowDuplicate: true }, b.rows[1]!] };
    expect(await owner((s) => s.imports!.apply(reviewed))).toBe("created");
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(100210);
  });
  it("rejects one invalid row, currency, overflow and reconciled dates without partial writes", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const b = batch(a.accountId);
    expect(
      await owner((s) =>
        s.imports!.apply({ ...b, rows: [b.rows[0]!, { ...b.rows[1]!, date: "2026-09-30" }] })
      )
    ).toBe("conflict");
    expect(await owner((s) => s.imports!.apply({ ...b, isoCurrency: "EUR" }))).toBe("conflict");
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"))).toBeNull();
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(100000);
    await owner((s) => s.reconciliation!.finish(statement(a.accountId)));
    expect(await owner((s) => s.imports!.apply({ ...b, expectedRevision: 1 }))).toBe("conflict");
    const max = account({ openingBalanceCents: Number.MAX_SAFE_INTEGER });
    await owner((s) => s.manual!.createAccount(max));
    expect(await owner((s) => s.imports!.apply(batch(max.accountId)))).toBe("conflict");
    expect(await owner((s) => s.getTransactionChunk(max.accountId, "2026-10"))).toBeNull();
  });
  it("serializes identical replay and distinct concurrent batches against one ledger revision", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const b = batch(a.accountId);
    expect(
      (
        await Promise.all([owner((s) => s.imports!.apply(b)), owner((s) => s.imports!.apply(b))])
      ).sort()
    ).toEqual(["created", "unchanged"]);
    const c = account();
    await owner((s) => s.manual!.createAccount(c));
    const c1 = batch(c.accountId),
      c2 = batch(c.accountId, { digest: "2".repeat(64) });
    expect(
      (
        await Promise.all([owner((s) => s.imports!.apply(c1)), owner((s) => s.imports!.apply(c2))])
      ).sort()
    ).toEqual(["conflict", "created"]);
    expect((await owner((s) => s.getTransactionChunk(c.accountId, "2026-10")))?.length).toBe(2);
  });
  it("makes a transaction identity collision abort the whole import and leaves no receipt", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const b = batch(a.accountId);
    await owner((s) => s.manual!.createEntry(entry(a.accountId, { id: `${b.id}:3` })));
    await expect(owner((s) => s.imports!.apply({ ...b, expectedRevision: 1 }))).rejects.toThrow();
    const rows = await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"));
    expect(rows).toHaveLength(1);
    expect((await owner((s) => s.getAccount(a.accountId)))?.balanceCents).toBe(91757);
    // A receipt would incorrectly turn this retry into unchanged.
    expect(await owner((s) => s.imports!.apply(b))).toBe("conflict");
  });
  it("keeps preview, entries and import receipts owner scoped", async () => {
    const a = account();
    await owner((s) => s.manual!.createAccount(a));
    const b = batch(a.accountId);
    expect(await owner((s) => s.imports!.apply(b))).toBe("created");
    expect(await owner((s) => s.imports!.preview(a.accountId, b.rows), ids.userB)).toBeNull();
    expect(await owner((s) => s.imports!.apply(b), ids.userB)).toBe("conflict");
    expect(await owner((s) => s.getTransactionChunk(a.accountId, "2026-10"), ids.userB)).toBeNull();
  });
});

describe("reviewed budget currency through owner-scoped installed storage", () => {
  it("requires acknowledgement before replacing an open untyped draft", async () => {
    await runner.withDataContext({ actorUserId: ids.adminUser }, async (scope) => {
      await createModuleStorageRpc(scope, "finance").query(
        "INSERT INTO app.finance_budget_drafts (owner_user_id, id, status, basis_from, basis_to, monthly_income_cents, created_at) VALUES (app.current_actor_user_id(), gen_random_uuid(), 'open', '2026-09-01', '2026-09-30', 10000, '2026-10-01T00:00:00Z')"
      );
    });
    expect(
      await owner(
        (s) => s.budgetPolicy!.configure("CAD", false, "2026-10-28T00:00:00Z"),
        ids.adminUser
      )
    ).toBe("legacy_review_required");
    expect((await owner((s) => s.getLatestDraft(), ids.adminUser))?.status).toBe("open");
    expect(
      await owner(
        (s) => s.budgetPolicy!.configure("CAD", true, "2026-10-28T00:00:00Z"),
        ids.adminUser
      )
    ).toBe("created");
    expect(await owner((s) => s.getLatestDraft(), ids.adminUser)).toBeNull();
  });

  it("requires legacy acknowledgement and preserves assignments exactly", async () => {
    await owner((s) => s.setAssignment("2026-01", "groceries", 12345));
    expect(await owner((s) => s.budgetPolicy!.get())).toBeNull();
    expect(
      await owner((s) => s.budgetPolicy!.configure("USD", false, "2026-10-28T00:00:00Z"))
    ).toBe("legacy_review_required");
    expect(await owner((s) => s.budgetPolicy!.get())).toBeNull();
    expect(await owner((s) => s.budgetPolicy!.configure("USD", true, "2026-10-28T00:00:00Z"))).toBe(
      "created"
    );
    expect(await owner((s) => s.getLedger("2026-01"))).toEqual({
      assignments: { groceries: 12345 }
    });
    expect(await owner((s) => s.budgetPolicy!.configure("USD", true, "2026-10-28T00:00:00Z"))).toBe(
      "unchanged"
    );
    expect(await owner((s) => s.budgetPolicy!.configure("EUR", true, "2026-10-28T00:00:00Z"))).toBe(
      "conflict"
    );
  });
  it("keeps another owner's currency private and serializes competing setup choices", async () => {
    expect(await owner((s) => s.budgetPolicy!.get(), ids.userB)).toBeNull();
    const results = await Promise.all([
      owner((s) => s.budgetPolicy!.configure("EUR", false, "2026-10-28T00:00:00Z"), ids.userB),
      owner((s) => s.budgetPolicy!.configure("GBP", false, "2026-10-28T00:00:00Z"), ids.userB)
    ]);
    expect(results.sort()).toEqual(["conflict", "created"]);
    expect((await owner((s) => s.budgetPolicy!.get()))?.isoCurrency).toBe("USD");
    const logs = await owner(
      (s) => s.listActivity("2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z", 200),
      ids.userB
    );
    expect(logs.filter((row) => row.kind === "budget.configure")).toHaveLength(1);
  });
});

describe("reviewed atomic budget writes through installed SQL", () => {
  const c = <T>(fn: (s: ReturnType<typeof store>) => Promise<T>) => owner(fn, ids.userC);
  const d = <T>(fn: (s: ReturnType<typeof store>) => Promise<T>) => owner(fn, ids.userD);
  const cash = account();
  const change = (expected: BudgetReview, amountCents: number): BudgetChange => ({
    expected,
    month: "2026-10",
    assignments: [{ categoryId: "groceries", amountCents }],
    activity: [
      {
        actor: "user",
        kind: "budget.assign",
        params: { month: "2026-10", categoryId: "groceries", amountCents },
        undo: { month: "2026-10", categoryId: "groceries", amountCents: 0 }
      }
    ]
  });
  beforeAll(async () => {
    await c((s) => s.budgetPolicy!.configure("USD", false, "2026-10-28T00:00:00Z"));
    await d((s) => s.budgetPolicy!.configure("USD", false, "2026-10-28T00:00:00Z"));
    await c((s) => s.manual!.createAccount(cash));
  });
  it("admits one of two simultaneous assignments and one matching activity row", async () => {
    const review = (await c((s) => s.budgetPolicy!.get()))!;
    const results = await Promise.all([
      c((s) => s.commitBudgetChange(change(review, 1000))),
      c((s) => s.commitBudgetChange(change(review, 2000)))
    ]);
    expect(results.sort()).toEqual([false, true]);
    const stored = (await c((s) => s.getLedger("2026-10")))!.assignments.groceries;
    expect([1000, 2000]).toContain(stored);
    const rows = await c((s) => s.listActivity("2020-01-01", "2030-01-01", 200));
    expect(rows.filter((r) => r.kind === "budget.assign")).toHaveLength(1);
    expect(rows.find((r) => r.kind === "budget.assign")?.params.amountCents).toBe(stored);
    expect((await c((s) => s.budgetPolicy!.get()))!.revision).toBe(review.revision + 1);
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
    expect((await c((s) => s.getLedger("2026-10")))!.assignments.groceries).toBe(stored);
  });
  it("invalidates reviewed funds after a posted entry, split, snapshot, import and provider correction", async () => {
    const purchase = entry(cash.accountId, { amountCents: 123 });
    let review = (await c((s) => s.budgetPolicy!.get()))!;
    expect(await c((s) => s.manual!.createEntry(purchase))).toBe("created");
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
    review = (await c((s) => s.budgetPolicy!.get()))!;
    expect(
      await c((s) =>
        s.setTransactionSplits({
          transactionId: purchase.id,
          accountId: cash.accountId,
          month: "2026-10",
          expectedAmountCents: 123,
          expectedCurrency: "USD",
          expectedRevision: 0,
          splits: [
            { categoryId: "groceries", amountCents: 100 },
            { categoryId: "dining", amountCents: 23 }
          ]
        })
      )
    ).toBe(true);
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
    review = (await c((s) => s.budgetPolicy!.get()))!;
    await c((s) => s.putSnapshotChunk(cash.accountId, "2026-09", { "2026-09-30": 99999 }));
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
    review = (await c((s) => s.budgetPolicy!.get()))!;
    const revision = (await c((s) => s.getAccount(cash.accountId)))!.ledgerRevision!;
    expect(
      await c((s) =>
        s.imports!.apply({
          id: `manual:${randomUUID()}`,
          accountId: cash.accountId,
          isoCurrency: "USD",
          expectedRevision: revision,
          rows: [
            {
              sourceRow: 1,
              date: "2026-10-04",
              name: "Synthetic imported bill",
              amountCents: 99,
              notes: "",
              allowDuplicate: false
            }
          ],
          cleared: false,
          digest: "2".repeat(64),
          at: "2026-10-28T00:00:00Z"
        })
      )
    ).toBe("created");
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
    const provider = {
      accountId: "provider:budget-proof",
      itemId: null,
      name: "Synthetic bank",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: null,
      balanceCents: 10000,
      isoCurrency: "USD",
      updatedAt: "2026-10-28T00:00:00Z"
    };
    await c((s) => s.putAccount(provider));
    review = (await c((s) => s.budgetPolicy!.get()))!;
    await c((s) => s.putAccount({ ...provider, balanceCents: 9000 }));
    expect(await c((s) => s.commitBudgetChange(change(review, 9999)))).toBe(false);
  });
  it("rolls back the revision, totals and activity when any statement part violates a constraint", async () => {
    const review = (await c((s) => s.budgetPolicy!.get()))!;
    const before = await c((s) => s.getLedger("2026-10"));
    const invalid = change(review, 3000);
    invalid.assignments.push({ categoryId: "groceries", amountCents: 4000 });
    await expect(c((s) => s.commitBudgetChange(invalid))).rejects.toThrow();
    expect(await c((s) => s.getLedger("2026-10"))).toEqual(before);
    expect(await c((s) => s.budgetPolicy!.get())).toEqual(review);
  });
  it("does not undo a row or start a draft when the shared guard fails", async () => {
    const review = (await d((s) => s.budgetPolicy!.get()))!;
    const draftId = await d((s) =>
      s.createDraft(
        {
          basisFrom: "2026-09-01",
          basisTo: "2026-09-30",
          monthlyIncomeCents: 100000,
          lines: [
            {
              categoryKey: "new-goal",
              categoryName: "Synthetic goal",
              groupName: "Savings",
              basisMonthlyCents: 1000,
              proposedCents: 1000
            }
          ]
        },
        "2026-10-28T00:00:00Z",
        review
      )
    );
    expect(draftId).toBeTruthy();
    await d((s) =>
      s.appendActivity({ actor: "user", kind: "budget.assign", params: { amountCents: 0 } })
    );
    const log = (await d((s) => s.listActivity("2020-01-01", "2030-01-01", 200))).find(
      (r) => r.kind === "budget.assign"
    )!;
    const stale = (await d((s) => s.budgetPolicy!.get()))!;
    await d((s) => s.manual!.createAccount(account()));
    expect(
      await d((s) =>
        s.commitBudgetChange({
          ...change(stale, 1000),
          categories: [
            { id: "new-goal", group: "savings-goals", name: "Synthetic goal", archived: false }
          ],
          startDraft: { draftId: draftId!, at: "2026-10-28T00:00:00Z" },
          markUndone: { activityId: log.id, at: "2026-10-28T00:00:00Z" }
        })
      )
    ).toBe(false);
    expect((await d((s) => s.getLatestDraft()))!.status).toBe("open");
    expect(await d((s) => s.getLedger("2026-10"))).toBeNull();
    expect((await d((s) => s.getActivity(log.id)))!.undoneAt).toBeNull();
    expect((await d((s) => s.budgetPolicy!.categories()))!.some((x) => x.id === "new-goal")).toBe(
      false
    );
  });
  it("serializes draft edits with start and preserves the exact accepted plan", async () => {
    const draft = (await d((s) => s.getLatestDraft()))!;
    const review = (await d((s) => s.budgetPolicy!.get()))!;
    const line = draft.lines[0]!;
    const start = (expected: BudgetReview, cents: number): BudgetChange => ({
      ...change(expected, cents),
      assignments: [{ categoryId: line.categoryKey, amountCents: cents }],
      categories: [
        { id: line.categoryKey, name: line.categoryName, group: "savings-goals", archived: false }
      ],
      startDraft: { draftId: draft.id, at: "2026-10-28T00:00:00Z" }
    });
    const outcomes = await Promise.all([
      d((s) =>
        s.saveDraftLine(draft.id, { ...line, adjustedCents: 2000, adjustedBy: "user" }, review)
      ),
      d((s) => s.commitBudgetChange(start(review, 1000)))
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    const current = (await d((s) => s.getLatestDraft()))!;
    if (current.status === "open") {
      expect(current.lines[0]!.adjustedCents).toBe(2000);
      expect(await d((s) => s.getLedger("2026-10"))).toBeNull();
      const fresh = (await d((s) => s.budgetPolicy!.get()))!;
      expect(await d((s) => s.commitBudgetChange(start(fresh, 2000)))).toBe(true);
    }
    const saved = (await d((s) => s.getLatestDraft()))!;
    const amount = saved.lines[0]!.adjustedCents ?? saved.lines[0]!.proposedCents;
    expect((await d((s) => s.getLedger("2026-10")))!.assignments[line.categoryKey]).toBe(amount);
    const fresh = (await d((s) => s.budgetPolicy!.get()))!;
    expect(await d((s) => s.saveDraftLine(draft.id, { ...line, adjustedCents: 9999 }, fresh))).toBe(
      false
    );
    expect((await d((s) => s.budgetPolicy!.get()))!.revision).toBe(fresh.revision);
  });
  it("copies the authoritative taxonomy once without renaming it on a later migration replay", async () => {
    await runner.withDataContext({ actorUserId: ids.adminUser }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_budget_policy SET taxonomy_ready = false"
      )
    );
    const categories = [
      ...DEFAULT_CATEGORIES.map((x) =>
        x.id === "groceries" ? { ...x, name: "Synthetic custom groceries" } : x
      ),
      { id: "custom-legacy", name: "Synthetic legacy category", group: "personal", archived: true }
    ];
    const outcomes = await Promise.all([
      owner(
        (s) => s.budgetPolicy!.initializeCategories(categories, "2026-10-28T00:00:00Z"),
        ids.adminUser
      ),
      owner(
        (s) => s.budgetPolicy!.initializeCategories(categories, "2026-10-28T00:00:00Z"),
        ids.adminUser
      )
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await owner((s) => s.budgetPolicy!.categories(), ids.adminUser)).toEqual(categories);
    expect(
      await owner(
        (s) => s.budgetPolicy!.initializeCategories(DEFAULT_CATEGORIES, "2026-10-28T00:00:00Z"),
        ids.adminUser
      )
    ).toBe(false);
    expect(
      (await owner((s) => s.budgetPolicy!.categories(), ids.adminUser))!.find(
        (x) => x.id === "groceries"
      )!.name
    ).toBe("Synthetic custom groceries");
  });
});
