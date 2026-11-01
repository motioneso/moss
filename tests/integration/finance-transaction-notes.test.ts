import {
  providerFeed,
  feedPage,
  handoffPending,
  handoffPosted
} from "./helpers/finance-provider-feed.js";
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
import {
  transactionNoteReadHandler,
  transactionNoteSaveHandler
} from "../../external-modules/finance/src/worker/handlers/transaction-notes.js";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import type { TransactionRecord } from "../../external-modules/finance/src/domain/records.js";
import type { NoteTarget } from "../../external-modules/finance/src/domain/transaction-notes.js";
const at = "2026-10-30T12:00:00Z";
const run = (write: boolean, input: Record<string, unknown>, actorUserId: string = ids.userA) =>
  runner.withDataContext({ actorUserId }, (scope) =>
    (write ? transactionNoteSaveHandler : transactionNoteReadHandler)({
      store: async () => store(scope),
      now: () => new Date(at)
    } as unknown as WorkerPorts)(input)
  );
async function fresh(extra: Partial<TransactionRecord> = {}) {
  const id = randomUUID(),
    accountId = `synthetic:${randomUUID()}`;
  await owner(async (s) => {
    await s.putAccount({
      accountId,
      itemId: "note-item",
      name: "Synthetic notes",
      officialName: null,
      type: "depository",
      subtype: "checking",
      mask: null,
      balanceCents: 10000,
      isoCurrency: "USD",
      updatedAt: at
    });
    await s.putTransaction({
      id,
      accountId,
      date: "2026-10-15",
      amountCents: 1234,
      isoCurrency: "USD",
      name: "Synthetic note purchase",
      merchant: null,
      plaidCategory: null,
      categoryId: null,
      pending: false,
      pendingTransactionId: null,
      categorizedBy: null,
      reviewState: "needs_look",
      notes: "Original private note",
      ...extra
    });
  });
  return { transactionId: id, accountId, month: "2026-10" };
}
const read = (target: NoteTarget) => owner((s) => s.notes!.read(target));
const save = (target: NoteTarget, rev: string, notes: string) =>
  owner((s) => s.notes!.save(target, rev, notes, at));
beforeAll(async () => {
  if (process.env.MOSS_FINANCE_NOTE_RLS_NEGATIVE === "1") {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query("ALTER TABLE app.finance_transactions DISABLE ROW LEVEL SECURITY");
    } finally {
      await client.end();
    }
  }
});
describe("captured private transaction notes", () => {
  it("changes only the note, preserving financial/review fields and account revision", async () => {
    const t = await fresh({ pending: true, notes: "Original private note" }),
      r = (await read(t))!;
    const before = await owner(async (s) => ({
      rows: await s.listMonthTransactions(t.month),
      account: await s.getAccount(t.accountId)
    }));
    expect(
      await run(true, {
        ...t,
        writeRevision: r.writeRevision,
        notes: "  Synthetic café 🦉\nprivate context  "
      })
    ).toEqual({ status: "ok", outcome: "saved" });
    const after = await owner(async (s) => ({
      rows: await s.listMonthTransactions(t.month),
      account: await s.getAccount(t.accountId)
    }));
    const strip = (v: typeof before) => ({
      ...v,
      rows: v.rows.map(({ notes: _n, ...rest }) => rest)
    });
    expect(strip(after)).toEqual(strip(before));
    expect((await read(t))!.notes).toBe("  Synthetic café 🦉\nprivate context  ");
    const logs = await owner((s) => s.listActivity("2026-10-01", "2100-01-01", 100));
    const log = logs.find((a) => a.params.transactionId === t.transactionId)!;
    expect(log.kind).toBe("transaction.note");
    expect(log.undo).toBeNull();
    expect(JSON.stringify(log)).not.toContain("café");
  });
  it("preserves split allocations and their review state", async () => {
    const t = await fresh({
        splits: [
          { categoryId: "groceries", amountCents: 1000 },
          { categoryId: "utilities", amountCents: 234 }
        ],
        splitRevision: 2
      }),
      r = (await read(t))!;
    const before = await owner((s) => s.getTransactionChunk(t.accountId, t.month));
    expect(await save(t, r.writeRevision, "Split receipt context")).toBe("saved");
    const after = await owner((s) => s.getTransactionChunk(t.accountId, t.month));
    expect(after!.map((v) => ({ ...v, notes: undefined }))).toEqual(
      before!.map((v) => ({ ...v, notes: undefined }))
    );
  });
  it("allows notes on a reconciled linked transfer without touching either ledger or statement", async () => {
    const accounts = [`manual:${randomUUID()}`, `manual:${randomUUID()}`],
      operationId = randomUUID();
    await owner(async (s) => {
      await s.budgetPolicy!.configure("USD", false, at);
      for (const accountId of accounts)
        expect(
          await s.manual!.createAccount({
            accountId,
            name: "Synthetic transfer notes",
            type: "depository",
            subtype: "checking",
            isoCurrency: "USD",
            openingDate: "2026-10-01",
            openingBalanceCents: 10000,
            digest: "3".repeat(64),
            at
          })
        ).toBe("created");
      const available = await s.transfers!.accounts();
      expect(
        await s.transfers!.create({
          operationId,
          fromAccountId: accounts[0]!,
          toAccountId: accounts[1]!,
          fromRevision: available.find((a) => a.accountId === accounts[0])!.revision,
          toRevision: available.find((a) => a.accountId === accounts[1])!.revision,
          date: "2026-10-15",
          amountCents: 1234,
          isoCurrency: "USD",
          cleared: true,
          digest: "4".repeat(64),
          today: "2026-10-30",
          at
        })
      ).toBe("created");
      const view = (await s.reconciliation!.read(accounts[0]!, "2026-10-15"))!;
      expect(
        await s.reconciliation!.finish({
          id: randomUUID(),
          accountId: accounts[0]!,
          statementDate: "2026-10-15",
          balanceCents: 8766,
          isoCurrency: "USD",
          expectedRevision: view.revision,
          selectedIds: view.entries.map((e) => e.id),
          digest: "5".repeat(64),
          at
        })
      ).toBe("created");
    });
    const snapshot = () =>
      owner(async (s) =>
        Promise.all(
          accounts.map(async (id) => ({
            account: await s.getAccount(id),
            rows: await s.getTransactionChunk(id, "2026-10")
          }))
        )
      );
    const before = await snapshot(),
      row = before[0]!.rows![0]!,
      t = { transactionId: row.id, accountId: row.accountId, month: "2026-10" };
    expect(row.transferId).toBeTruthy();
    expect(row.reconciledAt).toBeTruthy();
    const r = (await read(t))!;
    expect(await save(t, r.writeRevision, "Statement context")).toBe("saved");
    const strip = (snap: typeof before) =>
      snap.map((v) => ({ ...v, rows: v.rows!.map((r) => ({ ...r, notes: undefined })) }));
    expect(strip(await snapshot())).toEqual(strip(before));
  });
  it("competing captured versions save once; stale changed and replayed writes refuse", async () => {
    const t = await fresh(),
      r = (await read(t))!;
    const outcomes = await Promise.all([
      save(t, r.writeRevision, "A"),
      save(t, r.writeRevision, "B")
    ]);
    expect(outcomes.sort()).toEqual(["saved", "stale"]);
    const current = (await read(t))!;
    expect(await save(t, r.writeRevision, current.notes)).toBe("stale");
    expect(await save(t, current.writeRevision, current.notes)).toBe("unchanged");
    expect((await read(t))!.writeRevision).toBe(current.writeRevision);
  });
  it("rejects wrong account/month and absent IDs without mutation", async () => {
    const t = await fresh(),
      r = (await read(t))!;
    for (const bad of [
      { ...t, accountId: "foreign" },
      { ...t, month: "2026-09" },
      { ...t, transactionId: randomUUID() }
    ]) {
      expect(await read(bad)).toBeNull();
      expect(await save(bad, r.writeRevision, "changed")).toBe("stale");
    }
    expect(await read(t)).toEqual(r);
  });
  it("accepts exactly 4,000 UTF-8 bytes, rejects larger, NUL, missing and malformed Unicode", async () => {
    const t = await fresh(),
      r = (await read(t))!;
    for (const notes of ["🦉".repeat(1001), "x\0y", "\ud800", undefined, null, 42])
      await expect(run(true, { ...t, writeRevision: r.writeRevision, notes })).rejects.toThrow();
    expect(await read(t)).toEqual(r);
    expect(await save(t, r.writeRevision, "🦉".repeat(1000))).toBe("saved");
    expect(new TextEncoder().encode((await read(t))!.notes)).toHaveLength(4000);
  });
  it("records an explicit clear even when the original note is absent", async () => {
    const t = await fresh({ notes: undefined }),
      r = (await read(t))!;
    expect(await save(t, r.writeRevision, "")).toBe("saved");
    expect((await owner((s) => s.getTransactionChunk(t.accountId, t.month)))![0]!.notes).toBe("");
  });
  it("preserves explicit clears through same-ID provider updates and durable handoffs", async () => {
    const t = await fresh({ pending: true }),
      r = (await read(t))!;
    expect(await save(t, r.writeRevision, "")).toBe("saved");
    await owner(async (s) => {
      await s.putItem({
        itemId: "note-item",
        institutionId: null,
        institutionName: "Synthetic provider",
        connectedAt: at,
        status: "connected"
      });
      const row = (await s.getTransactionChunk(t.accountId, t.month))![0]!;
      await s.putTransactionChunk(t.accountId, t.month, [{ ...row, notes: "stale provider note" }]);
      expect((await s.notes!.read(t))!.notes).toBe("");
      await s.providerHandoffs!.capture("note-item", [t.transactionId], [], at);
      const handed = await s.providerHandoffs!.load("note-item", [t.transactionId]);
      expect(handed).toHaveLength(1);
      expect(handed[0]!.notes).toBe("");
      expect(await s.notes!.read(t)).toBeNull();
    });
  });
  it("keeps an edited pending clear through actual sync handoff and posted convergence", async () => {
    const feed = providerFeed(db, ids.userB, {
      page: async (cursor) =>
        cursor === "removed"
          ? feedPage({ added: [handoffPosted] })
          : feedPage({
              removed: [{ transaction_id: handoffPending.id }],
              hasMore: true,
              nextCursor: "removed"
            })
    });
    await feed.seed(true);
    const t = {
      transactionId: handoffPending.id,
      accountId: handoffPending.accountId,
      month: handoffPending.date.slice(0, 7)
    };
    const r = (await feed.store.notes!.read(t))!;
    expect(await feed.store.notes!.save(t, r.writeRevision, "", at)).toBe("saved");
    expect(await feed.run()).toMatchObject({ status: "ok" });
    const posted = await feed.store.notes!.read({
      transactionId: handoffPosted.transaction_id,
      accountId: handoffPending.accountId,
      month: "2026-10"
    });
    expect(posted!.notes).toBe("");
    expect(await feed.store.notes!.read(t)).toBeNull();
  });
  for (const [label, user] of [
    ["foreign", ids.userB],
    ["admin", ids.adminUser]
  ] as const) {
    it(`refuses ${label} exact-ID reads`, async () => {
      const t = await fresh();
      expect(await owner((s) => s.notes!.read(t), user)).toBeNull();
      expect(await run(false, { ...t }, user)).toEqual({ available: false });
    });
    it(`refuses ${label} writes even with the actual captured revision`, async () => {
      const t = await fresh(),
        r = (await read(t))!;
      expect(await owner((s) => s.notes!.save(t, r.writeRevision, "intruder", at), user)).toBe(
        "stale"
      );
      expect(await read(t)).toEqual(r);
    });
  }
});
