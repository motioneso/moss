import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import {
  CALENDAR_SCOPE,
  ConnectorsRepository,
  createConnectorSecretCipher,
  GOOGLE_SYNC_QUEUE,
  registerGoogleSyncSweepWorker
} from "@moss/connectors";
import {
  assertMetadataOnlyPayload,
  createPgBossClient,
  sendJob,
  type Job,
  type PgBoss
} from "@moss/jobs";
import type { Kysely } from "kysely";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("Google schedule to root job", () => {
  let appDb: Kysely<MossDatabase>;
  let rootDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;

  beforeAll(async () => {
    process.env.JARVIS_CONNECTOR_SECRET_KEY = "test-connector-secret-key";
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    rootDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
    const repository = new ConnectorsRepository();
    const cipher = createConnectorSecretCipher();
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "schedule-test" },
      (db) =>
        repository.upsertGoogleAccount(db, {
          scopes: [CALENDAR_SCOPE],
          encryptedSecret: cipher.encryptJson({ kind: "synthetic-google-oauth" })
        })
    );

    boss = createPgBossClient(connectionStrings.worker, {
      schedule: true,
      cronMonitorIntervalSeconds: 1,
      cronWorkerIntervalSeconds: 1,
      connectionTimeoutMillis: 25_000
    });
    await boss.start();
  });

  afterAll(async () => {
    await Promise.allSettled([
      boss?.stop({ graceful: false }),
      appDb?.destroy(),
      rootDb?.destroy()
    ]);
  });

  async function scheduleRows(): Promise<
    Array<{
      key: string;
      cron: string;
      data: Record<string, unknown>;
      options: Record<string, unknown>;
    }>
  > {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query<{
        key: string;
        cron: string;
        data: Record<string, unknown>;
        options: Record<string, unknown>;
      }>(`SELECT key, cron, data, options FROM pgboss.schedule WHERE name = $1`, [
        GOOGLE_SYNC_QUEUE
      ]);
      return result.rows;
    } finally {
      await client.end();
    }
  }

  async function makeDue(): Promise<void> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      await client.query(
        `UPDATE pgboss.schedule SET cron = '* * * * *', updated_on = now() WHERE name = $1`,
        [GOOGLE_SYNC_QUEUE]
      );
    } finally {
      await client.end();
    }
  }

  it("creates exactly one actor-scoped root when the due schedule fires", async () => {
    const roots: Array<Job<Record<string, unknown>>> = [];
    let markJobActive: (() => void) | undefined;
    const jobActive = new Promise<void>((resolve) => {
      markJobActive = resolve;
    });
    let releaseJob: (() => void) | undefined;
    const releaseGate = new Promise<void>((resolve) => {
      releaseJob = resolve;
    });

    await boss.work(GOOGLE_SYNC_QUEUE, { pollingIntervalSeconds: 1 }, async ([job]) => {
      if (!job) return;
      roots.push(job as Job<Record<string, unknown>>);
      markJobActive?.();
      await releaseGate;
    });

    await registerGoogleSyncSweepWorker(boss, rootDb);

    const beforeDue = await scheduleRows();
    expect(beforeDue).toHaveLength(1);
    expect(beforeDue[0]).toMatchObject({
      key: ids.userA,
      cron: "*/15 * * * *",
      data: {
        actorUserId: ids.userA,
        kind: "google-sync",
        idempotencyKey: `schedule:${ids.userA}`,
        trigger: "schedule"
      },
      options: { tz: "UTC", key: ids.userA, singletonKey: ids.userA }
    });
    expect(() => assertMetadataOnlyPayload(beforeDue[0]?.data)).not.toThrow();
    await makeDue();

    // The due schedule fires and the worker picks up the resulting root job, but holds it
    // active (via releaseGate) instead of completing it immediately. That lets us prove the
    // exactly-once property directly: pg-boss's exclusive-policy singletonKey dedup must
    // refuse a second job for the same actor while the first is still created/active, so a
    // duplicate schedule fire (or a racing sweep tick) can never produce a second root. This
    // replaces waiting a fixed interval to observe that a second root did not arrive.
    await jobActive;

    const duplicateJobId = await sendJob(
      boss,
      GOOGLE_SYNC_QUEUE,
      {
        actorUserId: ids.userA,
        kind: "google-sync",
        idempotencyKey: `schedule:${ids.userA}`,
        trigger: "manual"
      },
      { singletonKey: ids.userA }
    );
    expect(duplicateJobId).toBeNull();

    releaseJob?.();

    expect(roots).toHaveLength(1);
    expect(roots[0]?.data).toEqual({
      actorUserId: ids.userA,
      kind: "google-sync",
      idempotencyKey: `schedule:${ids.userA}`,
      trigger: "schedule"
    });
  });
});
