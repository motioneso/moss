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
let setupReady = false;
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
const correctionNegative = process.env.MOSS_FINANCE_CORRECTION_NEGATIVE;
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => {
      if (
        correctionNegative === "duplicate" &&
        text.includes("INSERT INTO app.finance_transfer_corrections")
      ) {
        const guard =
          "AND NOT EXISTS (SELECT 1 FROM app.finance_transfer_corrections c WHERE c.owner_user_id=r.owner_user_id AND c.original_transfer_id=r.id)";
        expect(text).toContain(guard);
        text = text.replace(guard, "");
      }
      return { rows: [...(await rpc.query(text, params)).rows] as never[] };
    }
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

const today = "2026-10-30",
  at = "2026-10-30T05:00:00Z";
const account = (id: string, type = "depository", balance = 10000, user: string = ids.userA) =>
  owner(
    (s) =>
      s.manual!.createAccount({
        accountId: id,
        name: `Synthetic ${id}`,
        type,
        subtype: type === "other" ? "asset" : "checking",
        isoCurrency: "USD",
        openingDate: "2026-10-01",
        openingBalanceCents: balance,
        digest: "a".repeat(64),
        at
      }),
    user
  );
const snapshot = (id: string) => owner((s) => s.getAccount(id));
async function input(
  operationId: string,
  fromAccountId: string,
  toAccountId: string,
  amountCents = 1000
) {
  const rows = await owner((s) => s.transfers!.accounts());
  return {
    operationId,
    fromAccountId,
    toAccountId,
    fromRevision: rows.find((a) => a.accountId === fromAccountId)!.revision,
    toRevision: rows.find((a) => a.accountId === toAccountId)!.revision,
    date: today,
    amountCents,
    isoCurrency: "USD",
    cleared: true,
    digest: operationId.replaceAll("-", "").repeat(2),
    today,
    at
  };
}
async function whileAccountChanges(
  change: Awaited<ReturnType<typeof input>>,
  mutate: (s: ReturnType<typeof store>) => Promise<void>,
  record = (s: ReturnType<typeof store>) => s.transfers!.create(change)
) {
  let acquired!: () => void, advance!: () => void;
  const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    }),
    untilChange = new Promise<void>((resolve) => {
      advance = resolve;
    });
  const holder = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
    await createModuleStorageRpc(scope, "finance").query(
      "SELECT account_id FROM app.finance_accounts WHERE account_id IN ($1,$2) ORDER BY account_id FOR UPDATE",
      [change.fromAccountId, change.toAccountId]
    );
    acquired();
    await untilChange;
    await mutate(store(scope));
  });
  await locked;
  const pending = owner(record);
  const observer = new Client({ connectionString: connectionStrings.bootstrap });
  await observer.connect();
  // pg_stat_activity truncates long statements; observe the initial CTE, not the later insert.
  let waiting = false,
    settled!: [PromiseSettledResult<void>, PromiseSettledResult<Awaited<typeof pending>>];
  try {
    for (let attempt = 0; attempt < 80; attempt++) {
      const result = await observer.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE $1",
        ["%WITH locked AS MATERIALIZED%"]
      );
      if (result.rows[0].n >= 1) {
        waiting = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 25));
    }
  } finally {
    advance();
    await observer.end();
    settled = await Promise.allSettled([holder, pending]);
  }
  expect(waiting, "The transfer reached the account lock before the competing change").toBe(true);
  if (settled[0].status === "rejected") throw settled[0].reason;
  if (settled[1].status === "rejected") throw settled[1].reason;
  return settled[1].value;
}
describe("linked manual transfers", () => {
  it("records two linked exact legs and balances, without needing a budget or categories", async () => {
    await account("transfer:cash");
    await account("transfer:savings");
    const change = await input(
      "88000000-0000-4000-8000-000000000001",
      "transfer:cash",
      "transfer:savings",
      123
    );
    expect(await owner((s) => s.transfers!.create(change))).toBe("created");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(9877);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(10123);
    const rows = (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
      r.id.includes(change.operationId)
    );
    expect(rows.map((r) => r.amountCents).sort((a, b) => a - b)).toEqual([-123, 123]);
    expect(
      rows.every(
        (r) => r.categoryId === "transfers" && r.source === "manual" && !r.pending && r.cleared
      )
    ).toBe(true);
    expect(await owner((s) => s.transfers!.create(change))).toBe("unchanged");
    expect(await owner((s) => s.transfers!.create({ ...change, digest: "f".repeat(64) }))).toBe(
      "conflict"
    );
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(9877);
  });
  it("treats a card payment as lower cash and lower amount owed", async () => {
    await account("transfer:pay-cash");
    await account("transfer:card", "credit", 5000);
    const change = await input(
      "88000000-0000-4000-8000-000000000002",
      "transfer:pay-cash",
      "transfer:card",
      1234
    );
    expect(await owner((s) => s.transfers!.create(change))).toBe("created");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(8766);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(3766);
    expect(8766 - 3766).toBe(10000 - 5000);
  });
  it("records the inverse card movement with exact debt signs", async () => {
    const change = await input(
      "88000000-0000-4000-8000-000000000013",
      "transfer:card",
      "transfer:pay-cash",
      222
    );
    expect(await owner((s) => s.transfers!.create(change))).toBe("created");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(3988);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(8988);
    expect(8988 - 3988).toBe(10000 - 5000);
  });
  it("rejects stale versions, future dates, same endpoint and changed currencies without a half event", async () => {
    await account("transfer:guard-a");
    await account("transfer:guard-b");
    const change = await input(
      "88000000-0000-4000-8000-000000000003",
      "transfer:guard-a",
      "transfer:guard-b"
    );
    for (const patch of [
      { fromRevision: "f".repeat(32) },
      { date: "2026-11-01" },
      { date: "2026-09-30" },
      { toAccountId: change.fromAccountId },
      { isoCurrency: "EUR" }
    ])
      expect(await owner((s) => s.transfers!.create({ ...change, ...patch }))).toBe("changed");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(10000);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(10000);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
        r.id.includes(change.operationId)
      )
    ).toEqual([]);
  });
  it("does not offer foreign, provider, loan or asset endpoints", async () => {
    await account("transfer:foreign", "depository", 0, ids.userB);
    await account("transfer:loan", "loan", 5000);
    await account("transfer:asset", "other", 5000);
    const available = (await owner((s) => s.transfers!.accounts())).map((a) => a.accountId);
    expect(available).not.toContain("transfer:foreign");
    expect(available).not.toContain("transfer:loan");
    expect(available).not.toContain("transfer:asset");
    const change = await input(
      "88000000-0000-4000-8000-000000000004",
      "transfer:guard-a",
      "transfer:guard-b"
    );
    expect(
      await owner((s) => s.transfers!.create({ ...change, toAccountId: "transfer:foreign" }))
    ).toBe("changed");
    expect(
      await owner((s) => s.transfers!.create({ ...change, toAccountId: "transfer:loan" }))
    ).toBe("changed");
  });
  it("retains exact maximum cents and refuses either balance overflow atomically", async () => {
    await account("transfer:max-from", "depository", Number.MAX_SAFE_INTEGER);
    await account("transfer:max-to", "depository", 0);
    const change = await input(
      "88000000-0000-4000-8000-000000000005",
      "transfer:max-from",
      "transfer:max-to",
      Number.MAX_SAFE_INTEGER
    );
    expect(await owner((s) => s.transfers!.create(change))).toBe("created");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(0);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(Number.MAX_SAFE_INTEGER);
    const overflow = await input(
      "88000000-0000-4000-8000-000000000006",
      "transfer:guard-a",
      "transfer:max-to",
      1
    );
    expect(await owner((s) => s.transfers!.create(overflow))).toBe("changed");
    expect((await snapshot(overflow.fromAccountId))!.balanceCents).toBe(10000);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
        r.id.includes(overflow.operationId)
      )
    ).toEqual([]);
  });
  it("preserves transfer identity and prevents a leg becoming category spending or a split", async () => {
    const rows = (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
      r.id.includes("88000000-0000-4000-8000-000000000001")
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.transferId === "88000000-0000-4000-8000-000000000001")).toBe(true);
    for (const categoryId of [null, "groceries"])
      await expect(owner((s) => s.putTransaction({ ...rows[0]!, categoryId }))).rejects.toThrow();
    const row = rows[0]!;
    expect(
      await owner((s) =>
        s.setTransactionSplits({
          transactionId: row.id,
          accountId: row.accountId,
          month: "2026-10",
          expectedAmountCents: row.amountCents,
          expectedCurrency: row.isoCurrency,
          expectedRevision: 0,
          splits: [{ categoryId: "groceries", amountCents: row.amountCents }]
        })
      )
    ).toBe(false);
    const exported = await owner((s) => s.historyExport!.read({ accountId: row.accountId }));
    expect(exported.rows.find((r) => r.id === row.id)?.transferId).toBe(row.transferId);
  });
  it("refuses dates in either reconciled statement and cannot attach to a closed ledger", async () => {
    await account("transfer:statement");
    await account("transfer:closed", "depository", 0);
    const statement = (await owner((s) => s.reconciliation!.read("transfer:statement", today)))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "transfer:statement-proof",
          accountId: "transfer:statement",
          statementDate: today,
          balanceCents: 10000,
          isoCurrency: "USD",
          expectedRevision: statement.revision,
          selectedIds: [],
          digest: "c".repeat(64),
          at
        })
      )
    ).toBe("created");
    const change = await input(
      "88000000-0000-4000-8000-000000000007",
      "transfer:guard-a",
      "transfer:statement"
    );
    expect(await owner((s) => s.transfers!.create(change))).toBe("changed");
    const closed = (await owner((s) => s.accountLifecycle!.review("transfer:closed", today)))!;
    expect(
      await owner((s) =>
        s.accountLifecycle!.update({
          accountId: closed.accountId,
          expectedRevision: closed.revision,
          operation: "close",
          today,
          at
        })
      )
    ).toBe(true);
    expect(
      await owner((s) =>
        s.transfers!.create({
          ...change,
          toAccountId: closed.accountId,
          toRevision: closed.revision
        })
      )
    ).toBe("changed");
  });
  it("serializes opposite-direction captured transfers and identical-operation replays", async () => {
    await account("transfer:race-a");
    await account("transfer:race-b");
    const first = await input(
      "88000000-0000-4000-8000-000000000008",
      "transfer:race-a",
      "transfer:race-b",
      111
    );
    const other = await input(
      "88000000-0000-4000-8000-000000000009",
      "transfer:race-b",
      "transfer:race-a",
      222
    );
    let locked!: () => void, release!: () => void;
    const acquired = new Promise<void>((resolve) => {
        locked = resolve;
      }),
      untilRelease = new Promise<void>((resolve) => {
        release = resolve;
      });
    const holder = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      await createModuleStorageRpc(scope, "finance").query(
        "SELECT account_id FROM app.finance_accounts WHERE account_id IN ($1,$2) ORDER BY account_id FOR UPDATE",
        [first.fromAccountId, first.toAccountId]
      );
      locked();
      await untilRelease;
    });
    await acquired;
    const pending = Promise.all([
      owner((s) => s.transfers!.create(first)),
      owner((s) => s.transfers!.create(other))
    ]);
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      let waiting = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        const result = await observer.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE state='active' AND wait_event_type='Lock' AND query LIKE $1",
          ["%WITH locked AS MATERIALIZED%"]
        );
        if (result.rows[0].n >= 2) {
          waiting = true;
          break;
        }
        await new Promise((done) => setTimeout(done, 25));
      }
      expect(waiting, "Both opposite transfers reached the held account lock").toBe(true);
    } finally {
      release();
      await observer.end();
    }
    await holder;
    const outcomes = await pending;
    expect(outcomes.sort()).toEqual(["changed", "created"]);
    expect(
      (await snapshot(first.fromAccountId))!.balanceCents +
        (await snapshot(first.toAccountId))!.balanceCents
    ).toBe(20000);
    const repeated = await input(
      "88000000-0000-4000-8000-000000000010",
      "transfer:race-a",
      "transfer:race-b",
      123
    );
    expect(
      (
        await Promise.all([
          owner((s) => s.transfers!.create(repeated)),
          owner((s) => s.transfers!.create(repeated))
        ])
      ).sort()
    ).toEqual(["created", "unchanged"]);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).filter((r) =>
        r.id.includes(repeated.operationId)
      )
    ).toHaveLength(2);
  });
  it("keeps identical operation identifiers independent across owners and opaque to admins", async () => {
    await account("transfer:b-from", "depository", 10000, ids.userB);
    await account("transfer:b-to", "depository", 0, ids.userB);
    const accounts = await owner((s) => s.transfers!.accounts(), ids.userB);
    const operationId = "88000000-0000-4000-8000-000000000001";
    expect(
      await owner(
        (s) =>
          s.transfers!.create({
            operationId,
            fromAccountId: "transfer:b-from",
            toAccountId: "transfer:b-to",
            fromRevision: accounts.find((a) => a.accountId === "transfer:b-from")!.revision,
            toRevision: accounts.find((a) => a.accountId === "transfer:b-to")!.revision,
            date: today,
            amountCents: 777,
            isoCurrency: "USD",
            cleared: false,
            digest: "e".repeat(64),
            today,
            at
          }),
        ids.userB
      )
    ).toBe("created");
    const count = (actorUserId: string) =>
      runner.withDataContext(
        { actorUserId },
        async (scope) =>
          (
            await createModuleStorageRpc(scope, "finance").query(
              "SELECT count(*)::int AS n FROM app.finance_manual_transfers WHERE id=$1::uuid",
              [operationId]
            )
          ).rows[0]!.n
      );
    expect(await count(ids.userA)).toBe(1);
    expect(await count(ids.userB)).toBe(1);
    expect(await count(ids.adminUser)).toBe(0);
    expect((await snapshot("transfer:cash"))!.balanceCents).toBe(9877);
  });
  it("rejects a transfer after a competing close commits under its held destination lock", async () => {
    await account("transfer:close-race-from");
    await account("transfer:close-race-to", "depository", 0);
    const change = await input(
      "88000000-0000-4000-8000-000000000011",
      "transfer:close-race-from",
      "transfer:close-race-to"
    );
    expect(
      await whileAccountChanges(change, async (s) => {
        const saved = (await s.accountLifecycle!.review(change.toAccountId, today))!;
        expect(
          await s.accountLifecycle!.update({
            accountId: saved.accountId,
            expectedRevision: saved.revision,
            operation: "close",
            today,
            at
          })
        ).toBe(true);
      })
    ).toBe("changed");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(10000);
    expect((await snapshot(change.toAccountId))!.archivedAt).not.toBeNull();
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).some((r) =>
        r.id.includes(change.operationId)
      )
    ).toBe(false);
  });
  it("rejects a transfer after a statement is reconciled while it waits", async () => {
    await account("transfer:reconcile-race-from");
    await account("transfer:reconcile-race-to", "depository", 0);
    const change = await input(
      "88000000-0000-4000-8000-000000000012",
      "transfer:reconcile-race-from",
      "transfer:reconcile-race-to"
    );
    expect(
      await whileAccountChanges(change, async (s) => {
        const statement = (await s.reconciliation!.read(change.fromAccountId, today))!;
        expect(
          await s.reconciliation!.finish({
            id: "transfer:race-statement",
            accountId: change.fromAccountId,
            statementDate: today,
            balanceCents: 10000,
            isoCurrency: "USD",
            expectedRevision: statement.revision,
            selectedIds: [],
            digest: "c".repeat(64),
            at
          })
        ).toBe("created");
      })
    ).toBe("changed");
    expect((await snapshot(change.fromAccountId))!.balanceCents).toBe(10000);
    expect((await snapshot(change.toAccountId))!.balanceCents).toBe(0);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).some((r) =>
        r.id.includes(change.operationId)
      )
    ).toBe(false);
  });
});

let correctionFixtureNumber = 0;
async function correctionFixture(card = false, fromBalance = 10000, toBalance = card ? 5000 : 0) {
  const key = ++correctionFixtureNumber,
    from = `correction:${key}:from`,
    to = `correction:${key}:to`,
    originalId = `99000000-0000-4000-8000-${String(key).padStart(12, "0")}`;
  await account(from, "depository", fromBalance);
  await account(to, card ? "credit" : "depository", toBalance);
  const original = { ...(await input(originalId, from, to, 1234)), date: "2026-10-28" };
  expect(await owner((s) => s.transfers!.create(original))).toBe("created");
  return { from, to, originalId };
}
async function correctionInput(originalId: string, suffix = 1) {
  const original = (await owner((s) => s.transferCorrections!.read(originalId)))!;
  return {
    ...(await input(
      `99100000-0000-4000-8000-${String(correctionFixtureNumber * 10 + suffix).padStart(12, "0")}`,
      original.toAccountId,
      original.fromAccountId,
      original.amountCents
    )),
    originalTransferId: originalId,
    sourceRevision: original.sourceRevision,
    date: "2026-10-29"
  };
}
const reverse = (change: Awaited<ReturnType<typeof correctionInput>>) =>
  owner((s) => s.transferCorrections!.reverse(change));
const correctionRows = (id: string) =>
  owner(async (s) =>
    (await s.listMonthTransactions("2026-10")).filter((row) => row.transferId === id)
  );
describe("audited manual transfer corrections", () => {
  it("appends one exact cash inverse, preserves the original and handles replay before eligibility", async () => {
    const f = await correctionFixture(),
      oldRows = await correctionRows(f.originalId),
      change = await correctionInput(f.originalId);
    expect(await reverse(change)).toBe("created");
    expect((await snapshot(f.from))!.balanceCents).toBe(10000);
    expect((await snapshot(f.to))!.balanceCents).toBe(0);
    expect(await correctionRows(f.originalId)).toEqual(oldRows);
    expect((await correctionRows(change.operationId)).map((r) => r.amountCents).sort()).toEqual([
      -1234, 1234
    ]);
    expect(await owner((s) => s.transferCorrections!.read(f.originalId))).toMatchObject({
      correctedBy: { transferId: change.operationId, date: change.date }
    });
    expect(await owner((s) => s.transferCorrections!.read(change.operationId))).toMatchObject({
      correctsTransferId: f.originalId
    });
    const accounts = [await snapshot(f.from), await snapshot(f.to)];
    expect(await reverse(change)).toBe("unchanged");
    expect(await reverse({ ...change, digest: "f".repeat(64) })).toBe("conflict");
    const duplicate = await correctionInput(f.originalId, 2);
    if (correctionNegative === "duplicate") {
      // Disposable fixture only: prove both the SQL guard and relational invariant matter.
      const client = new Client({ connectionString: connectionStrings.bootstrap });
      await client.connect();
      try {
        await client.query(
          "ALTER TABLE app.finance_transfer_corrections DROP CONSTRAINT finance_transfer_corrections_pkey"
        );
        try {
          expect(await reverse(duplicate)).toBe("changed");
        } finally {
          await client.query(
            "DELETE FROM app.finance_transfer_corrections WHERE correction_transfer_id=$1::uuid",
            [duplicate.operationId]
          );
          await client.query(
            "ALTER TABLE app.finance_transfer_corrections ADD PRIMARY KEY(owner_user_id,original_transfer_id)"
          );
        }
      } finally {
        await client.end();
      }
    } else expect(await reverse(duplicate)).toBe("changed");
    expect([await snapshot(f.from), await snapshot(f.to)]).toEqual(accounts);
    expect(await correctionRows(change.operationId)).toHaveLength(2);
    const activity = await owner((s) => s.listActivity("2026-10-01", "2026-11-01", 200));
    expect(
      activity.find(
        (a) => a.kind === "transfer.reverse" && a.params.transferId === change.operationId
      )?.params.originalTransferId
    ).toBe(f.originalId);
  });
  it("restores card debt signs and retains both correction links in complete owned history", async () => {
    const f = await correctionFixture(true),
      change = await correctionInput(f.originalId);
    expect((await snapshot(f.to))!.balanceCents).toBe(3766);
    expect(await reverse(change)).toBe("created");
    expect((await snapshot(f.from))!.balanceCents).toBe(10000);
    expect((await snapshot(f.to))!.balanceCents).toBe(5000);
    const exported = await owner((s) => s.historyExport!.read({ accountId: f.from }));
    expect(exported.rows.find((r) => r.transferId === f.originalId)).toMatchObject({
      correctedByTransferId: change.operationId
    });
    expect(exported.rows.find((r) => r.transferId === change.operationId)).toMatchObject({
      correctsTransferId: f.originalId
    });
    const again = await correctionInput(change.operationId, 3);
    expect(await reverse(again)).toBe("created");
    expect((await snapshot(f.from))!.balanceCents).toBe(8766);
    expect((await snapshot(f.to))!.balanceCents).toBe(3766);
    expect(await owner((s) => s.transferCorrections!.read(change.operationId))).toMatchObject({
      correctsTransferId: f.originalId,
      correctedBy: { transferId: again.operationId }
    });
  });
  it("refuses changed source, versions, amount, endpoints, currency and posting dates without partial records", async () => {
    const f = await correctionFixture(),
      change = await correctionInput(f.originalId),
      before = [await snapshot(f.from), await snapshot(f.to)],
      old = await correctionRows(f.originalId);
    for (const patch of [
      { sourceRevision: "0".repeat(32) },
      { fromRevision: "0".repeat(32) },
      { toRevision: "0".repeat(32) },
      { amountCents: 1235 },
      { amountCents: 0 },
      { amountCents: Number.MAX_SAFE_INTEGER + 1 },
      { fromAccountId: change.toAccountId, toAccountId: change.fromAccountId },
      { isoCurrency: "EUR" },
      { date: "2026-10-27" },
      { date: "2026-10-31" }
    ])
      expect(await reverse({ ...change, ...patch })).toBe("changed");
    expect([await snapshot(f.from), await snapshot(f.to)]).toEqual(before);
    expect(await correctionRows(f.originalId)).toEqual(old);
    expect(await correctionRows(change.operationId)).toEqual([]);
    // Explicit malformed legacy leg fixture; public correction must not reinterpret it as valid.
    await runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
      createModuleStorageRpc(scope, "finance").query(
        "UPDATE app.finance_transactions SET amount_cents=amount_cents+CASE WHEN amount_cents>0 THEN 1 ELSE -1 END WHERE id=$1",
        [old[0]!.id]
      )
    );
    expect(await owner((s) => s.transferCorrections!.read(f.originalId))).toMatchObject({
      intact: false
    });
    expect(await reverse(await correctionInput(f.originalId))).toBe("changed");
    expect([await snapshot(f.from), await snapshot(f.to)]).toEqual(before);
  });
  it("serializes two distinct corrections from one captured review", async () => {
    const f = await correctionFixture(),
      a = await correctionInput(f.originalId),
      b = await correctionInput(f.originalId, 2);
    expect((await Promise.all([reverse(a), reverse(b)])).sort()).toEqual(["changed", "created"]);
    expect((await snapshot(f.from))!.balanceCents).toBe(10000);
    expect((await snapshot(f.to))!.balanceCents).toBe(0);
    expect(
      (await correctionRows(a.operationId)).length + (await correctionRows(b.operationId)).length
    ).toBe(2);
  });
  it("preserves reconciled original periods and accepts only a later new correction date", async () => {
    const f = await correctionFixture();
    for (const accountId of [f.from, f.to]) {
      const statement = (await owner((s) => s.reconciliation!.read(accountId, "2026-10-28")))!;
      const row = (await correctionRows(f.originalId)).find((r) => r.accountId === accountId)!;
      expect(
        await owner((s) =>
          s.reconciliation!.finish({
            id: `${accountId}:statement`,
            accountId,
            statementDate: "2026-10-28",
            balanceCents: accountId === f.from ? 10000 - 1234 : 1234,
            isoCurrency: "USD",
            expectedRevision: statement.revision,
            selectedIds: [row.id],
            digest: "c".repeat(64),
            at
          })
        )
      ).toBe("created");
    }
    const original = await correctionRows(f.originalId),
      change = await correctionInput(f.originalId);
    expect(original.every((r) => r.reconciledAt)).toBe(true);
    expect(await reverse({ ...change, date: "2026-10-28" })).toBe("changed");
    expect(await reverse(change)).toBe("created");
    expect(await correctionRows(f.originalId)).toEqual(original);
  });
  it("rejects a correction after reconciliation and ledger close commit while it waits", async () => {
    const f = await correctionFixture(false, 10000, -1234),
      change = await correctionInput(f.originalId);
    const leg = (await correctionRows(f.originalId)).find((r) => r.accountId === f.to)!;
    expect(
      await whileAccountChanges(
        change,
        async (s) => {
          const statement = (await s.reconciliation!.read(f.to, today))!;
          expect(
            await s.reconciliation!.finish({
              id: `${f.to}:statement`,
              accountId: f.to,
              statementDate: today,
              balanceCents: 0,
              isoCurrency: "USD",
              expectedRevision: statement.revision,
              selectedIds: [leg.id],
              digest: "c".repeat(64),
              at
            })
          ).toBe("created");
          const saved = (await s.accountLifecycle!.review(f.to, today))!;
          expect(saved.canClose).toBe(true);
          expect(
            await s.accountLifecycle!.update({
              accountId: f.to,
              expectedRevision: saved.revision,
              operation: "close",
              today,
              at
            })
          ).toBe(true);
        },
        (s) => s.transferCorrections!.reverse(change)
      )
    ).toBe("changed");
    expect(await correctionRows(change.operationId)).toEqual([]);
    expect((await snapshot(f.to))!.archivedAt).not.toBeNull();
  });
  it("keeps original reviews and correction link ownership opaque to foreign users and admins", async () => {
    const f = await correctionFixture(),
      change = await correctionInput(f.originalId);
    expect(await reverse(change)).toBe("created");
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      if (correctionNegative === "rls")
        await client.query(
          "ALTER TABLE app.finance_transfer_corrections DISABLE ROW LEVEL SECURITY"
        );
      for (const actor of [ids.userB, ids.adminUser]) {
        expect(await owner((s) => s.transferCorrections!.read(f.originalId), actor)).toBeNull();
        expect(await owner((s) => s.transferCorrections!.reverse(change), actor)).toBe("changed");
        const visible = await runner.withDataContext({ actorUserId: actor }, (scope) =>
          createModuleStorageRpc(scope, "finance").query(
            "SELECT correction_transfer_id FROM app.finance_transfer_corrections WHERE original_transfer_id=$1::uuid",
            [f.originalId]
          )
        );
        expect(visible.rows).toEqual([]);
      }
    } finally {
      if (correctionNegative === "rls") {
        await client.query(
          "ALTER TABLE app.finance_transfer_corrections ENABLE ROW LEVEL SECURITY"
        );
        await client.query("ALTER TABLE app.finance_transfer_corrections FORCE ROW LEVEL SECURITY");
      }
      await client.end();
    }
  });
});
