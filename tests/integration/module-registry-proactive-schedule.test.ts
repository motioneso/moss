import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  buildReconcileProactiveSchedule,
  getBuiltInModuleManifests,
  proactiveMonitorProvidersFor
} from "@moss/module-registry";
import { PROACTIVE_SCAN_SOURCE_QUEUE } from "@moss/proactive-monitoring";
import { defaultProactiveMonitoringPreference } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("proactive-monitoring schedule key", () => {
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();
    boss = createPgBossClient(connectionStrings.worker, {
      schedule: true,
      connectionTimeoutMillis: 25_000
    });
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
  });

  async function scheduleRows(): Promise<Array<{ key: string }>> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{ key: string }>(
        `SELECT key FROM pgboss.schedule WHERE name = $1`,
        [PROACTIVE_SCAN_SOURCE_QUEUE.name]
      );
      return result.rows;
    } finally {
      await client.end();
    }
  }

  it("registers tasks as a real proactive-monitoring source", () => {
    const providers = proactiveMonitorProvidersFor(getBuiltInModuleManifests());
    expect(providers.map((p) => p.provider.source)).toContain("tasks");
  });

  it("schedules a proactive-monitoring key with a real pg-boss client — no colon", async () => {
    const pref = {
      ...defaultProactiveMonitoringPreference(),
      enabled: true,
      sources: {
        ...defaultProactiveMonitoringPreference().sources,
        tasks: { ...defaultProactiveMonitoringPreference().sources.tasks, enabled: true }
      }
    };

    const reconcile = buildReconcileProactiveSchedule(boss);
    await expect(reconcile(ids.userA, pref)).resolves.not.toThrow();

    const rows = await scheduleRows();
    const taskRow = rows.find((row) => row.key === `${ids.userA}/tasks`);
    expect(taskRow).toBeDefined();
    expect(taskRow?.key.includes(":")).toBe(false);
  });

  it("unschedules with the same slash-separated key when a source is disabled", async () => {
    const enabledPref = {
      ...defaultProactiveMonitoringPreference(),
      enabled: true,
      sources: {
        ...defaultProactiveMonitoringPreference().sources,
        tasks: { ...defaultProactiveMonitoringPreference().sources.tasks, enabled: true }
      }
    };
    const reconcile = buildReconcileProactiveSchedule(boss);
    await reconcile(ids.userA, enabledPref);
    expect((await scheduleRows()).some((row) => row.key === `${ids.userA}/tasks`)).toBe(true);

    const disabledPref = {
      ...enabledPref,
      sources: {
        ...enabledPref.sources,
        tasks: { ...enabledPref.sources.tasks, enabled: false }
      }
    };
    await expect(reconcile(ids.userA, disabledPref)).resolves.not.toThrow();
    expect((await scheduleRows()).some((row) => row.key === `${ids.userA}/tasks`)).toBe(false);
  });
});
