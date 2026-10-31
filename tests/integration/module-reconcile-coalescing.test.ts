import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { ExternalModuleJobReconciler } from "@moss/module-registry/node";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let boss: PgBoss;
let transaction: Client;
beforeAll(async () => {
  await resetFoundationDatabase();
  boss = createPgBossClient(connectionStrings.worker);
  await boss.start();
  transaction = new Client({ connectionString: connectionStrings.worker });
  await transaction.connect();
  await transaction.query("BEGIN");
});
afterAll(async () => {
  if (transaction) {
    await transaction.query("ROLLBACK");
    await transaction.end();
  }
  await boss?.stop({ graceful: false });
});

describe("real reconciliation burst coalescing", () => {
  it("coalesces same-package inserts in one real database time bucket and admits an updated package", async () => {
    const queue = "fixture-reconcile.storage-migrate";
    let module: ExternalModuleDiscovery = {
      id: "fixture-reconcile",
      dir: "/unused-synthetic-module",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {
        schemaVersion: 1,
        id: "fixture-reconcile",
        name: "Synthetic reconcile",
        version: "1.0.0",
        publisher: "Moss tests",
        lifecycle: "optional",
        compatibility: { jarv1s: ">=0.1.0" },
        worker: {
          queues: [{ name: queue, handler: "storage.migrate" }],
          reconcileJobs: [
            { id: "storage-migrate", queue, jobKind: "fixture-reconcile.storage-migrate" }
          ]
        }
      }
    };
    // Real pg-boss SQL and PostgreSQL uniqueness. Its supported send adapter pins only
    // the transaction's now(), so crossing a wall-clock bucket cannot falsify the test.
    const port = new Proxy(boss, {
      get(target, key) {
        if (key === "send")
          return (name: string, data: object, options: object) =>
            target.send(name, data, {
              ...options,
              db: {
                executeSql: (text: string, values?: unknown[]) => transaction.query(text, values)
              }
            });
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const reconciler = new ExternalModuleJobReconciler({
      boss: port,
      discoveries: () => [module],
      isModuleEnabled: async () => true,
      listActiveUserIds: async () => [ids.userA]
    });
    const count = async () =>
      Number(
        (await transaction.query("SELECT count(*) FROM pgboss.job_common WHERE name=$1", [queue]))
          .rows[0].count
      );
    await reconciler.reconcileModule(module.id);
    await reconciler.reconcileModule(module.id);
    expect(await count()).toBe(1);
    module = { ...module, packageHash: `sha256:${"c".repeat(64)}` };
    await reconciler.reconcileModule(module.id);
    expect(await count()).toBe(2);
  });
});
