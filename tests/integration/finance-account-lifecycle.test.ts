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

const today = "2026-10-30",
  at = "2026-10-30T05:00:00Z";
const query = (text: string, params: unknown[] = []) =>
  runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
const review = (id: string, user: string = ids.userA) =>
  owner((s) => s.accountLifecycle!.review(id, today), user);
const createAccount = (id: string, balance = 0, user: string = ids.userA) =>
  owner(
    (s) =>
      s.manual!.createAccount({
        accountId: id,
        name: `Synthetic ${id}`,
        type: "depository",
        subtype: "checking",
        isoCurrency: "USD",
        openingDate: "2026-10-01",
        openingBalanceCents: balance,
        digest: "a".repeat(64),
        at
      }),
    user
  );
const entry = (id: string, amount = 1000, date = "2026-10-15") =>
  owner((s) =>
    s.manual!.createEntry({
      id: `${id}:entry`,
      accountId: id,
      date,
      name: "Synthetic retained movement",
      amountCents: amount,
      isoCurrency: "USD",
      categoryId: "groceries",
      notes: "Synthetic retained private note",
      cleared: true,
      digest: "b".repeat(64),
      at
    })
  );
const update = async (
  id: string,
  operation: "rename" | "close" | "reopen",
  name?: string,
  expectedRevision?: string
) => {
  const current = await review(id);
  return owner((s) =>
    s.accountLifecycle!.update({
      accountId: id,
      operation,
      name,
      expectedRevision: expectedRevision ?? current!.revision,
      today,
      at
    })
  );
};
const policy = async () => (await owner((s) => s.budgetPolicy!.get()))!;
const plan = (id: string, accountId: string) => ({
  id,
  name: "Synthetic account bill",
  accountId,
  categoryId: "utilities",
  isoCurrency: "USD",
  amountCents: 1000,
  anchorDate: "2026-11-01",
  cadence: "weekly" as const
});
beforeAll(async () => {
  for (const user of [ids.userA, ids.userB])
    await owner((s) => s.budgetPolicy!.configure("USD", false, at), user);
});
describe("reviewed manual account lifecycle", () => {
  it("renames with row CAS while preserving money, dates, ledger revision and metadata-only activity", async () => {
    await createAccount("life:name", 10000);
    await entry("life:name");
    const before = await owner((s) => s.getAccount("life:name")),
      captured = (await review("life:name"))!;
    expect(captured.blockers).toContain("nonzero_balance");
    expect(
      await update("life:name", "rename", "Synthetic renamed <ledger>", captured.revision)
    ).toBe(true);
    expect(await owner((s) => s.getAccount("life:name"))).toEqual({
      ...before,
      name: "Synthetic renamed <ledger>"
    });
    expect(await update("life:name", "rename", "Stale name", captured.revision)).toBe(false);
    const current = (await review("life:name"))!;
    expect(await update("life:name", "rename", current.name, current.revision)).toBe(true);
    expect((await review("life:name"))!.revision).toBe(current.revision);
    const activity = await owner((s) => s.listActivity("2026-10-01", "2100-01-01", 100));
    expect(activity.filter((a) => a.kind === "account.rename")).toHaveLength(1);
    expect(JSON.stringify(activity.filter((a) => a.kind === "account.rename"))).not.toContain(
      "renamed"
    );
  });
  it("closes and reopens a pristine zero ledger without fabricating entries", async () => {
    await createAccount("life:empty");
    const original = await owner((s) => s.getAccount("life:empty"));
    expect((await review("life:empty"))!.canClose).toBe(true);
    expect(await update("life:empty", "close")).toBe(true);
    expect((await owner((s) => s.getAccount("life:empty")))!.archivedAt).not.toBeNull();
    expect(await entry("life:empty", 1)).toBe("unavailable");
    expect(await owner((s) => s.imports!.preview("life:empty", []))).toBeNull();
    expect(await update("life:empty", "reopen")).toBe(true);
    expect(await owner((s) => s.getAccount("life:empty"))).toEqual(original);
    expect(
      (await owner((s) => s.listMonthTransactions("2026-10"))).filter(
        (r) => r.accountId === "life:empty"
      )
    ).toEqual([]);
  });
  it("requires a current zero statement, keeps history and retains reconciliation locks after reopening", async () => {
    await createAccount("life:statement", 1000);
    await entry("life:statement");
    expect((await review("life:statement"))!.blockers).toEqual(["unreconciled"]);
    const first = (await owner((s) => s.reconciliation!.read("life:statement", "2026-10-29")))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "life:first-statement",
          accountId: "life:statement",
          statementDate: "2026-10-29",
          balanceCents: 0,
          isoCurrency: "USD",
          expectedRevision: first.revision,
          selectedIds: ["life:statement:entry"],
          digest: "c".repeat(64),
          at
        })
      )
    ).toBe("created");
    expect((await review("life:statement"))!.canClose).toBe(false);
    const next = (await owner((s) => s.reconciliation!.read("life:statement", today)))!;
    expect(
      await owner((s) =>
        s.reconciliation!.finish({
          id: "life:current-statement",
          accountId: "life:statement",
          statementDate: today,
          balanceCents: 0,
          isoCurrency: "USD",
          expectedRevision: next.revision,
          selectedIds: [],
          digest: "d".repeat(64),
          at
        })
      )
    ).toBe("created");
    const before = await owner((s) => s.listMonthTransactions("2026-10"));
    expect(await update("life:statement", "close")).toBe(true);
    expect(
      await owner((s) => s.historyExport!.read({ accountId: "life:statement" }))
    ).toMatchObject({ totalCount: 1 });
    expect(await update("life:statement", "reopen")).toBe(true);
    // A new identity still cannot enter the reconciled period.
    expect(
      await owner((s) =>
        s.manual!.createEntry({
          id: "life:late-entry",
          accountId: "life:statement",
          date: today,
          name: "Synthetic late entry",
          amountCents: 1,
          isoCurrency: "USD",
          categoryId: "groceries",
          notes: "",
          cleared: true,
          digest: "e".repeat(64),
          at
        })
      )
    ).toBe("reconciled_period");
    expect(await owner((s) => s.listMonthTransactions("2026-10"))).toEqual(before);
  });
  it("refuses corrupted and future ledger history even when the stored balance is zero", async () => {
    await createAccount("life:corrupt");
    await entry("life:corrupt", 1);
    await query("UPDATE app.finance_accounts SET balance_cents=0 WHERE account_id=$1", [
      "life:corrupt"
    ]);
    expect((await review("life:corrupt"))!.blockers).toContain("invalid_ledger");
    expect(await update("life:corrupt", "close")).toBe(false);
    await createAccount("life:future", 1000);
    await entry("life:future", 1000, "2026-11-01");
    expect((await review("life:future"))!.blockers).toContain("future_entries");
    expect(await update("life:future", "close")).toBe(false);
  });
  it("never reads or updates another owner's or a provider account", async () => {
    await createAccount("life:foreign", 0, ids.userB);
    expect(await review("life:foreign")).toBeNull();
    expect(await review("life:foreign", ids.adminUser)).toBeNull();
    const foreign = (await review("life:foreign", ids.userB))!;
    expect(
      await owner((s) =>
        s.accountLifecycle!.update({
          accountId: "life:foreign",
          operation: "rename",
          name: "Wrong owner",
          expectedRevision: foreign.revision,
          today,
          at
        })
      )
    ).toBe(false);
    await owner((s) =>
      s.putAccount({
        accountId: "life:provider",
        itemId: null,
        name: "Synthetic provider",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: null,
        balanceCents: 0,
        isoCurrency: "USD",
        updatedAt: at
      })
    );
    expect(await review("life:provider")).toBeNull();
    expect(
      await owner((s) =>
        s.accountLifecycle!.update({
          accountId: "life:provider",
          operation: "close",
          expectedRevision: "a".repeat(32),
          today,
          at
        })
      )
    ).toBe(false);
  });
  it("blocks future bill references and allows a stopped plan to end sooner without changing financial fields", async () => {
    await createAccount("life:bill");
    const before = await owner((s) => s.getAccount("life:bill")),
      old = (await review("life:bill"))!;
    const p = plan("99000000-0000-4000-8000-000000000001", "life:bill"),
      expected = await policy();
    expect(await owner((s) => s.bills!.create(p, expected, at))).toBe(true);
    expect(await owner((s) => s.getAccount("life:bill"))).toEqual(before);
    expect((await review("life:bill"))!.revision).not.toBe(old.revision);
    expect((await review("life:bill"))!.blockers).toContain("future_plans");
    expect(await update("life:bill", "close", undefined, old.revision)).toBe(false);
    let e = await policy();
    expect(await owner((s) => s.bills!.stop(p.id, "2026-11-10", e, at))).toBe(true);
    expect((await review("life:bill"))!.canClose).toBe(false);
    e = await policy();
    expect(await owner((s) => s.bills!.stop(p.id, today, e, at))).toBe(true);
    expect((await review("life:bill"))!.canClose).toBe(true);
    expect(await update("life:bill", "close")).toBe(true);
  });
  async function waitForCloseLock() {
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const result = await blockedFinanceWrites(observer, "%reviewed AS MATERIALIZED%");
          expect(result).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 }
      );
    } finally {
      await observer.end();
    }
  }
  it("rejects a closer when an entry commits while it waits on the account", async () => {
    await createAccount("life:entry-race");
    const captured = (await review("life:entry-race"))!;
    let release!: () => void, locked!: () => void;
    const untilRelease = new Promise<void>((r) => {
        release = r;
      }),
      acquired = new Promise<void>((r) => {
        locked = r;
      });
    const holder = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query(
        "SELECT account_id FROM app.finance_accounts WHERE account_id=$1 FOR UPDATE",
        ["life:entry-race"]
      );
      locked();
      await untilRelease;
      expect(
        await store(scope).manual!.createEntry({
          id: "life:race-entry",
          accountId: "life:entry-race",
          date: today,
          name: "Synthetic concurrent entry",
          amountCents: 1,
          isoCurrency: "USD",
          categoryId: "groceries",
          notes: "",
          cleared: true,
          digest: "f".repeat(64),
          at
        })
      ).toBe("created");
    });
    await acquired;
    const closer = update("life:entry-race", "close", undefined, captured.revision);
    try {
      await waitForCloseLock();
    } finally {
      release();
    }
    await holder;
    expect(await closer).toBe(false);
    expect(await owner((s) => s.getAccount("life:entry-race"))).toMatchObject({
      balanceCents: -1,
      archivedAt: null
    });
  });
  it("rejects a close reviewed before a competing bill attachment commits", async () => {
    await createAccount("life:bill-race");
    const captured = (await review("life:bill-race"))!,
      expected = await policy();
    let release!: () => void, locked!: () => void;
    const untilRelease = new Promise<void>((r) => {
        release = r;
      }),
      acquired = new Promise<void>((r) => {
        locked = r;
      });
    const holder = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      expect(
        await store(scope).bills!.create(
          plan("99000000-0000-4000-8000-000000000002", "life:bill-race"),
          expected,
          at
        )
      ).toBe(true);
      locked();
      await untilRelease;
    });
    await acquired;
    const closer = update("life:bill-race", "close", undefined, captured.revision);
    try {
      await waitForCloseLock();
    } finally {
      release();
    }
    await holder;
    expect(await closer).toBe(false);
    expect((await review("life:bill-race"))!.futurePlanCount).toBe(1);
    expect((await owner((s) => s.getAccount("life:bill-race")))!.archivedAt).toBeNull();
  });
});
