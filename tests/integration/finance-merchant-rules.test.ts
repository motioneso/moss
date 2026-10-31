import { blockedFinanceWrites } from "./helpers/finance-write-barrier.js";
import {
  rulesListHandler,
  rulesPreviewHandler,
  rulesUpdateHandler
} from "../../external-modules/finance/src/worker/handlers/merchant-rules.js";
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
import { sql, type Kysely } from "kysely";
import { installModule } from "../../scripts/module-install.js";
import {
  sqlStore,
  contentHash,
  normalizePayee,
  NS,
  type FinanceDb,
  type MerchantRuleChange
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
let setupReady = false;
const runtimeRole = moduleRuntimeRoleName("finance");
const installRole = moduleInstallRoleName("finance");
function store(scope: DataContextDb) {
  const rpc = createModuleStorageRpc(scope, "finance");
  const port: FinanceDb = {
    query: async (text, params) => ({
      rows: [
        ...(
          await rpc.query(
            process.env.MOSS_FINANCE_RULES_CAS_NEGATIVE === "1"
              ? text
                  .replace("revision=$5", "$5::text IS NOT NULL")
                  .replace(
                    "md5(finance_merchant_rules.id || ':' || finance_merchant_rules.xmin::text)=$5",
                    "$5::text IS NOT NULL"
                  )
                  .replace("md5(r.id || ':' || r.xmin::text)=$2", "$2::text IS NOT NULL")
              : text,
            params
          )
        ).rows
      ] as never[]
    })
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

import {
  getModuleKvValue,
  setModuleKvValue,
  deleteModuleKvKey,
  listModuleKvKeys
} from "@moss/settings";
import type { WorkerPorts } from "../../external-modules/finance/src/worker/ports.js";
import { runStorageMigrate } from "../../external-modules/finance/src/worker/handlers/migrate.js";
import {
  effectiveMerchantRules,
  RULES_MIGRATED_KEY
} from "../../external-modules/finance/src/worker/merchant-rules.js";
import { loadCategories } from "../../external-modules/finance/src/worker/handlers/feed.js";
import { categorize } from "../../external-modules/finance/src/domain/categorize.js";
const at = "2026-10-30T00:00:00Z";
async function withPorts<T>(fn: (ports: WorkerPorts) => Promise<T>) {
  return runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
    await sql`SELECT set_config('app.current_module_id','finance',true)`.execute(scope.db);
    const address = (namespace: string) => ({
      moduleId: "finance",
      namespace,
      scope: "user" as const,
      ownerUserId: ids.userA
    });
    const rpc = createModuleStorageRpc(scope, "finance");
    const port: FinanceDb = {
      query: async (text, params) => ({
        rows: [...(await rpc.query(text, params)).rows] as never[]
      })
    };
    const ports = {
      db: port,
      store: async () => store(scope),
      now: () => new Date(at),
      kv: {
        get: (namespace: string, key: string) =>
          getModuleKvValue(scope, { ...address(namespace), key }),
        set: (namespace: string, key: string, value: Record<string, unknown>) =>
          setModuleKvValue(scope, { ...address(namespace), key }, value),
        delete: (namespace: string, key: string) =>
          deleteModuleKvKey(scope, { ...address(namespace), key }),
        list: (namespace: string) => listModuleKvKeys(scope, address(namespace))
      }
    } as unknown as WorkerPorts;
    return fn(ports);
  });
}
const change = (
  merchant: string,
  categoryId = "groceries",
  expectedRevision: string | null = null,
  enabled = true
): MerchantRuleChange => ({
  id: contentHash(normalizePayee(merchant)),
  payeeKey: normalizePayee(merchant),
  categoryId,
  enabled,
  expectedRevision,
  actor: "user",
  at
});
const current = (merchant: string) =>
  owner(async (s) => (await s.rules!.all()).find((r) => r.id === change(merchant).id)!);
const activities = () => owner((s) => s.listActivity("2026-10-01", "2026-11-01", 500));
const query = (text: string, params: unknown[] = []) =>
  runner.withDataContext({ actorUserId: ids.userA }, (scope) =>
    createModuleStorageRpc(scope, "finance").query(text, params)
  );
beforeAll(async () => {
  for (const actor of [ids.userA, ids.userB])
    await owner(async (s) => {
      await s.budgetPolicy!.configure("USD", false, at);
      await s.putAccount({
        accountId: "synthetic:rules",
        itemId: null,
        name: "Synthetic rules account",
        officialName: null,
        type: "depository",
        subtype: "checking",
        mask: null,
        balanceCents: 50000,
        isoCurrency: "USD",
        updatedAt: at
      });
    }, actor);
  await owner((s) =>
    s.putTransaction({
      id: "synthetic:rules:history",
      accountId: "synthetic:rules",
      date: "2026-10-01",
      amountCents: 1234,
      isoCurrency: "USD",
      name: "Synthetic history",
      merchant: null,
      plaidCategory: null,
      categoryId: "groceries",
      pending: false,
      pendingTransactionId: null,
      categorizedBy: "user",
      reviewState: "confirmed",
      notes: "Synthetic private note"
    })
  );
});

describe("canonical owned merchant rules", () => {
  it("upgrades newest legacy rules without deleting KV or overwriting a canonical disabled row", async () => {
    await withPorts(async (ports) => {
      const payeeKey = "synthetic legacy",
        id = contentHash(payeeKey);
      const old = { payeeKey, categoryId: "groceries", createdAt: "2026-10-01T00:00:00Z" };
      const newest = { ...old, categoryId: "dining", createdAt: "2026-10-02T00:00:00Z" };
      await ports.kv.set(NS.rules, id, old);
      await ports.kv.set(NS.rules, `rule:${id}`, newest);
      await ports.kv.set(NS.meta, "storage:migrated", { at });
      expect(await runStorageMigrate(ports)).toEqual({ status: "already-migrated" });
      const s = await ports.store(),
        migrated = (await s.rules!.all()).find((r) => r.id === id)!;
      expect(migrated).toMatchObject({ payeeKey, categoryId: "dining", enabled: true });
      expect(await ports.kv.get(NS.rules, id)).toEqual(old);
      expect(await ports.kv.get(NS.rules, `rule:${id}`)).toEqual(newest);
      expect(
        await s.rules!.apply({ ...change(payeeKey, "dining", migrated.writeRevision, false) })
      ).toBe(true);
      await ports.kv.delete(NS.meta, RULES_MIGRATED_KEY);
      await runStorageMigrate(ports);
      expect((await s.rules!.all()).find((r) => r.id === id)?.enabled).toBe(false);
      expect((await effectiveMerchantRules(ports, s)).some((r) => r.payeeKey === payeeKey)).toBe(
        false
      );
      expect(await ports.kv.get(NS.meta, RULES_MIGRATED_KEY)).not.toBeNull();
    });
  });
  it("commits captured updates and identifier-only activity together and refuses stale or conflicting absence", async () => {
    const name = "Synthetic captured",
      before = (await activities()).length;
    expect(await owner((s) => s.rules!.apply(change(name)))).toBe(true);
    const first = await current(name);
    expect(await owner((s) => s.rules!.apply(change(name, "dining", first.writeRevision)))).toBe(
      true
    );
    expect(await owner((s) => s.rules!.apply(change(name, "savings", first.writeRevision)))).toBe(
      false
    );
    expect(await owner((s) => s.rules!.apply(change(name)))).toBe(false);
    expect(await current(name)).toMatchObject({ categoryId: "dining", enabled: true });
    const all = await activities();
    expect(all).toHaveLength(before + 2);
    expect(JSON.stringify(all)).not.toContain("synthetic captured");
  });
  it("keeps owner and admin reads/writes within their own rule rows", async () => {
    const name = "Synthetic private",
      c = change(name);
    expect(await owner((s) => s.rules!.apply(c))).toBe(true);
    const captured = await current(name);
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    const negative = process.env.MOSS_FINANCE_RULES_RLS_NEGATIVE === "1";
    try {
      if (negative)
        await observer.query("ALTER TABLE app.finance_merchant_rules DISABLE ROW LEVEL SECURITY");
      for (const actor of [ids.userB, ids.adminUser]) {
        expect(
          (await owner((s) => s.rules!.all(), actor)).find((r) => r.id === c.id)
        ).toBeUndefined();
        expect(
          await owner(
            (s) =>
              s.rules!.apply({
                ...c,
                categoryId: "dining",
                expectedRevision: captured.writeRevision
              }),
            actor
          )
        ).toBe(false);
      }
    } finally {
      if (negative)
        await observer.query(
          "ALTER TABLE app.finance_merchant_rules ENABLE ROW LEVEL SECURITY; ALTER TABLE app.finance_merchant_rules FORCE ROW LEVEL SECURITY"
        );
      await observer.end();
    }
    expect(await current(name)).toMatchObject({ categoryId: "groceries" });
  });
  it("permits disabling an archived destination, refuses enabling it, and accepts a live replacement", async () => {
    const name = "Synthetic archive";
    expect(await owner((s) => s.rules!.apply(change(name)))).toBe(true);
    await query(
      "UPDATE app.finance_categories SET archived_at=$1::timestamptz WHERE id='groceries'",
      [at]
    );
    try {
      let row = await current(name);
      expect(
        await owner((s) => s.rules!.apply(change(name, "groceries", row.writeRevision, false)))
      ).toBe(true);
      row = await current(name);
      expect(await owner((s) => s.rules!.apply(change(name, "groceries", row.writeRevision)))).toBe(
        false
      );
      expect(await owner((s) => s.rules!.apply(change(name, "missing", row.writeRevision)))).toBe(
        false
      );
      expect(await owner((s) => s.rules!.apply(change(name, "dining", row.writeRevision)))).toBe(
        true
      );
    } finally {
      await query("UPDATE app.finance_categories SET archived_at=NULL WHERE id='groceries'");
    }
  });
  it("admits only one competing captured update", async () => {
    const name = "Synthetic concurrent";
    await owner((s) => s.rules!.apply(change(name)));
    const row = await current(name);
    const results = await Promise.all(
      ["dining", "savings"].map((categoryId) =>
        owner((s) => s.rules!.apply(change(name, categoryId, row.writeRevision)))
      )
    );
    expect(results.sort()).toEqual([false, true]);
  });
  it("restores configuration, reversal activity and undone mark atomically; new-rule Undo keeps a disabled tombstone", async () => {
    const name = "Synthetic undo";
    await owner((s) => s.rules!.apply(change(name)));
    let row = await current(name);
    await owner((s) => s.rules!.apply(change(name, "dining", row.writeRevision)));
    row = await current(name);
    const activity = (await activities()).find(
      (a) => a.params.ruleId === row.id && a.params.categoryId === "dining"
    )!;
    expect(await owner((s) => s.rules!.undo(activity.id, row.writeRevision, at))).toBe(true);
    expect(await current(name)).toMatchObject({ categoryId: "groceries", enabled: true });
    expect((await activities()).find((a) => a.id === activity.id)?.undoneAt).not.toBeNull();
    expect(await owner((s) => s.rules!.undo(activity.id, row.writeRevision, at))).toBe(false);
    const fresh = "Synthetic new undo";
    await owner((s) => s.rules!.apply(change(fresh)));
    const added = await current(fresh),
      create = (await activities()).find((a) => a.params.ruleId === added.id)!;
    expect(await owner((s) => s.rules!.undo(create.id, added.writeRevision, at))).toBe(true);
    expect(await current(fresh)).toMatchObject({ categoryId: "groceries", enabled: false });
  });
  it("refuses stale Undo even when a later edit keeps the same category", async () => {
    const name = "Synthetic stale undo";
    await owner((s) => s.rules!.apply(change(name)));
    const row = await current(name),
      activity = (await activities()).find((a) => a.params.ruleId === row.id)!;
    await owner((s) => s.rules!.apply(change(name, row.categoryId, row.writeRevision)));
    expect(await owner((s) => s.rules!.undo(activity.id, row.writeRevision, at))).toBe(false);
    expect((await activities()).find((a) => a.id === activity.id)?.undoneAt).toBeNull();
  });
  it("rechecks a rule changed while its captured update waits for a row lock", async () => {
    const name = "Synthetic blocked";
    await owner((s) => s.rules!.apply(change(name)));
    const row = await current(name),
      count = (await activities()).length;
    let unlock!: () => void, acquired!: () => void;
    const release = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const held = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const blocker = runner.withDataContext({ actorUserId: ids.userA }, async (scope) => {
      const rpc = createModuleStorageRpc(scope, "finance");
      await rpc.query("SELECT id FROM app.finance_merchant_rules WHERE id=$1 FOR UPDATE", [row.id]);
      acquired();
      await release;
      await rpc.query("UPDATE app.finance_merchant_rules SET category_id='dining' WHERE id=$1", [
        row.id
      ]);
    });
    await held;
    const contender = owner((s) => s.rules!.apply(change(name, "savings", row.writeRevision)));
    const observer = new Client({ connectionString: connectionStrings.bootstrap });
    await observer.connect();
    try {
      await vi.waitFor(
        async () => {
          const state = await blockedFinanceWrites(observer, "%previous AS MATERIALIZED%");
          expect(state).toBeGreaterThan(0);
        },
        { timeout: 5000, interval: 25 }
      );
    } finally {
      unlock();
      await observer.end();
    }
    await blocker;
    expect(await contender).toBe(false);
    expect(await current(name)).toMatchObject({ categoryId: "dining" });
    expect(await activities()).toHaveLength(count);
  });
  it("skips broken legacy rules, copies the rest and still finishes the upgrade", async () => {
    await withPorts(async (ports) => {
      await ports.kv.delete(NS.meta, RULES_MIGRATED_KEY);
      const valid = { payeeKey: "synthetic import valid", categoryId: "groceries", createdAt: at };
      const broken = {
        "synthetic:malformed": { ...valid, payeeKey: "synthetic malformed", createdAt: "invalid" },
        "synthetic:too-long": { ...valid, payeeKey: "q".repeat(201) },
        "synthetic:unavailable": {
          ...valid,
          payeeKey: "synthetic import unavailable",
          categoryId: "missing"
        }
      };
      await ports.kv.set(NS.rules, "synthetic:valid", valid);
      for (const [key, rule] of Object.entries(broken)) await ports.kv.set(NS.rules, key, rule);
      try {
        await runStorageMigrate(ports);
        const stored = await (await ports.store()).rules!.all();
        const find = (payeeKey: string) => stored.find((r) => r.id === contentHash(payeeKey));
        expect(find(valid.payeeKey)).toMatchObject({ enabled: true, categoryId: "groceries" });
        expect(find("synthetic malformed")).toBeUndefined();
        expect(find("synthetic import unavailable")).toBeUndefined();
        expect(await ports.kv.get(NS.meta, RULES_MIGRATED_KEY)).not.toBeNull();
        expect(await ports.kv.get(NS.rules, "synthetic:valid")).toEqual(valid);
        for (const [key, rule] of Object.entries(broken))
          expect(await ports.kv.get(NS.rules, key)).toEqual(rule);
      } finally {
        for (const key of Object.keys(broken)) await ports.kv.delete(NS.rules, key);
      }
    });
  });
  it("refuses an archived Undo destination without marking activity or changing the rule", async () => {
    const name = "Synthetic unavailable undo";
    await owner((s) => s.rules!.apply(change(name)));
    const original = await current(name);
    await owner((s) => s.rules!.apply(change(name, "dining", original.writeRevision)));
    const row = await current(name),
      all = await activities();
    const activity = all.find(
      (a) => a.params.ruleId === row.id && a.params.categoryId === "dining"
    )!;
    await query(
      "UPDATE app.finance_categories SET archived_at=$1::timestamptz WHERE id='groceries'",
      [at]
    );
    try {
      expect(await owner((s) => s.rules!.undo(activity.id, row.writeRevision, at))).toBe(false);
      expect(await current(name)).toEqual(row);
      expect(await activities()).toHaveLength(all.length);
      expect((await activities()).find((a) => a.id === activity.id)?.undoneAt).toBeNull();
    } finally {
      await query("UPDATE app.finance_categories SET archived_at=NULL WHERE id='groceries'");
    }
  });
  it("distinguishes initialization from emptiness and previews bounded owned history without changing it", async () => {
    await withPorts(async (ports) => {
      const marker = await ports.kv.get(NS.meta, RULES_MIGRATED_KEY);
      await ports.kv.delete(NS.meta, RULES_MIGRATED_KEY);
      expect(await rulesListHandler(ports)({})).toEqual({ supported: true, ready: false });
      await ports.kv.set(NS.meta, RULES_MIGRATED_KEY, marker!);
      const result = await rulesListHandler(ports)({ search: "Synthetic Captured #99", limit: 1 });
      expect(result).toMatchObject({ ready: true, total: 1, limit: 1 });
      expect((result.rules as unknown[]).length).toBe(1);
      const s = await ports.store(),
        history = await s.listMonthTransactions("2026-10"),
        count = (await s.listActivity("2026-10-01", "2026-11-01", 500)).length;
      const preview = await rulesPreviewHandler(ports)({
        merchant: "Synthetic History #1",
        month: "2026-10"
      });
      expect(preview).toMatchObject({ payeeKey: "synthetic history", total: 1, limit: 20 });
      expect(JSON.stringify(preview)).not.toContain("Synthetic private note");
      expect(await s.listMonthTransactions("2026-10")).toEqual(history);
      expect(await s.listActivity("2026-10-01", "2026-11-01", 500)).toHaveLength(count);
      expect(
        await rulesUpdateHandler(ports)({
          merchant: "Synthetic native API",
          categoryId: "dining",
          enabled: true
        })
      ).toMatchObject({ status: "ok" });
      await expect(
        rulesUpdateHandler(ports)({
          merchant: "Synthetic native API",
          categoryId: "groceries",
          enabled: true
        })
      ).rejects.toThrow("Nothing was saved");
    });
  });

  it("applies enabled canonical rules to synthetic future arrivals without overwriting user allocations or financial facts", async () => {
    const name = "Synthetic future";
    await owner((s) => s.rules!.apply(change(name, "dining")));
    await withPorts(async (ports) => {
      const s = await ports.store(),
        history = (await s.listMonthTransactions("2026-10"))[0]!;
      const untouched = { ...history, id: "synthetic:protected", name };
      const arrival = {
        ...history,
        id: "synthetic:arrival",
        name,
        categoryId: null,
        categorizedBy: null
      };
      const policy = {
        sortingTier: "ask_each_time" as const,
        sortingNewTier: "ask_each_time" as const,
        seenPayeeKeys: new Set<string>()
      };
      const result = await categorize(
        [arrival, untouched],
        await effectiveMerchantRules(ports, s),
        await loadCategories(ports),
        null,
        policy
      );
      expect(result[0]).toEqual({
        ...arrival,
        categoryId: "dining",
        categorizedBy: "rule",
        reviewState: "confirmed",
        aiConfidence: null
      });
      expect(result[1]).toEqual(untouched);
      expect(await s.getAccount("synthetic:rules")).toMatchObject({
        balanceCents: 50000,
        updatedAt: at
      });
      expect((await s.listMonthTransactions("2026-10"))[0]).toEqual(history);
    });
  });
});
