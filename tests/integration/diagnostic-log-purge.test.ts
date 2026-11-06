import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { assertMetadataOnlyPayload, createPgBossClient, type PgBoss } from "@moss/jobs";
import {
  DIAGNOSTIC_LOG_MAX_ROWS,
  DIAGNOSTIC_LOG_PURGE_CRON,
  DIAGNOSTIC_LOG_PURGE_QUEUE,
  registerSettingsJobWorkers,
  type DiagnosticLogPurgeJobPayload
} from "@moss/settings";
import type { Kysely } from "kysely";

import { connectionStrings, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #3978 slice 2B: the hourly log purge through a real pg-boss run. The job is queued with a real
// boss and handled by the callback that registerSettingsJobWorkers registers, not a direct call.

describe("diagnostic log purge job", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let boot: pg.Client;

  async function count(where = "true"): Promise<number> {
    const r = await boot.query(
      `SELECT count(*)::int AS n FROM app.diagnostic_log_records WHERE ${where}`
    );
    return r.rows[0].n as number;
  }

  async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 70_000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  async function runPurgeJob(): Promise<void> {
    // The purge job has no actor, so it is sent with boss.send like the schedule does.
    const payload: DiagnosticLogPurgeJobPayload = { kind: "diagnostics.log_purge" };
    assertMetadataOnlyPayload(payload);
    const jobId = await boss.send(DIAGNOSTIC_LOG_PURGE_QUEUE, payload);
    expect(jobId).not.toBeNull();
    await waitFor(async () => {
      const job = await boss.getJobById(DIAGNOSTIC_LOG_PURGE_QUEUE, jobId as string);
      if (job?.state === "failed") throw new Error("the purge job failed");
      return job?.state === "completed";
    }, "the purge job to complete");
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    boot = new Client({ connectionString: connectionStrings.bootstrap });
    await boot.connect();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    boss = createPgBossClient(connectionStrings.worker, {
      schedule: true,
      connectionTimeoutMillis: 25_000
    });
    await boss.start();
    await registerSettingsJobWorkers(boss, new DataContextRunner(appDb), workerDb, () => []);
  });

  afterAll(async () => {
    await Promise.allSettled([
      boss?.stop({ graceful: false }),
      appDb?.destroy(),
      workerDb?.destroy(),
      boot?.end()
    ]);
  });

  it("registers the hourly schedule with a metadata-only payload", async () => {
    const r = await boot.query(`SELECT cron, data FROM pgboss.schedule WHERE name = $1`, [
      DIAGNOSTIC_LOG_PURGE_QUEUE
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].cron).toBe(DIAGNOSTIC_LOG_PURGE_CRON);
    expect(r.rows[0].data).toEqual({ kind: "diagnostics.log_purge" });
  });

  it("deletes aged rows and rows beyond the cap when a real queued job runs", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    // 50,500 recent rows (500 over the cap), 30 rows past 7 days, and 5 clearly fresh rows.
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now() - interval '1 day' - (g * interval '1 second'), 'api', 40, 'api', 'recent' || g
       FROM generate_series(1, $1::int) g`,
      [DIAGNOSTIC_LOG_MAX_ROWS + 500]
    );
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now() - interval '8 days' - (g * interval '1 second'), 'api', 40, 'api', 'aged' || g
       FROM generate_series(1, 30) g`
    );
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now(), 'api', 40, 'api', 'fresh' || g FROM generate_series(1, 5) g`
    );

    await runPurgeJob();
    expect(await count()).toBe(DIAGNOSTIC_LOG_MAX_ROWS);
    expect(await count("message LIKE 'aged%'")).toBe(0);
    expect(await count("message LIKE 'fresh%'")).toBe(5);
    // The worker polls every 30 s, so allow for one full poll plus the purge itself.
  }, 90_000);

  it("deletes rows past 7 days even when the table is well below the cap", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now() - interval '8 days' - (g * interval '1 second'), 'api', 40, 'api', 'aged' || g
       FROM generate_series(1, 20) g`
    );
    await boot.query(
      `INSERT INTO app.diagnostic_log_records (occurred_at, process, level, component, message)
       SELECT now() - interval '1 day' - (g * interval '1 second'), 'api', 40, 'api', 'recent' || g
       FROM generate_series(1, 10) g`
    );

    await runPurgeJob();

    expect(await count("message LIKE 'aged%'")).toBe(0);
    expect(await count("message LIKE 'recent%'")).toBe(10);
  }, 90_000);
});

describe("diagnostic log purge ownership", () => {
  const read = (path: string): string => readFileSync(path, "utf8");
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) return name === "node_modules" ? [] : sourceFiles(full);
      return full.endsWith(".ts") ? [full] : [];
    });

  it("is scheduled only from the worker process, never the API", () => {
    const apiHits = sourceFiles("apps/api/src").filter((file) =>
      /registerBuiltInModuleWorkers|registerSettingsJobWorkers|reconcileDiagnosticLogPurgeSchedule/.test(
        read(file)
      )
    );
    expect(apiHits).toEqual([]);
    expect(read("apps/worker/src/worker.ts")).toContain("registerBuiltInModuleWorkers(boss");
    // The production chain: worker.ts -> registerBuiltInModuleWorkers -> settings workers.
    expect(read("packages/module-registry/src/index.ts")).toMatch(
      /return registerSettingsJobWorkers\(\s*boss,/
    );
    expect(read("packages/settings/src/data-export-jobs.ts")).toContain(
      "await reconcileDiagnosticLogPurgeSchedule(boss)"
    );
  });
});
