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
