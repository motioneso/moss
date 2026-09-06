import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgBoss } from "pg-boss";
import pg from "pg";

import {
  GOOGLE_SYNC_QUEUE,
  GOOGLE_SYNC_QUEUE_DEFINITIONS,
  type GoogleSyncPayload
} from "@moss/connectors";
import { createPgBossClient, migratePgBoss, sendJob } from "@moss/jobs";

import { connectionStrings, ids, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

describe("connectors google sync exclusive singleton recovery (#650)", () => {
  let boss: PgBoss;
  let adminClient: pg.Client;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    await migratePgBoss(connectionStrings.migration, GOOGLE_SYNC_QUEUE_DEFINITIONS);

    adminClient = new Client({ connectionString: connectionStrings.bootstrap });
    await adminClient.connect();

    boss = createPgBossClient(connectionStrings.worker);
    await boss.start();
  });

  afterAll(async () => {
    await boss?.stop({ graceful: false });
    await adminClient?.end();
  });

  it("releases a stale active exclusive singleton after pg-boss supervision", async () => {
    const actorUserId = ids.userA;
    const payload: GoogleSyncPayload = {
      actorUserId,
      kind: "google-sync",
      idempotencyKey: "sync-wedge-regression",
      trigger: "manual"
    };

    try {
      const firstJobId = await sendJob(boss, GOOGLE_SYNC_QUEUE, payload, {
        singletonKey: actorUserId
      });
      expect(firstJobId).toEqual(expect.any(String));

      await adminClient.query(
        `
          UPDATE pgboss.job
          SET state = 'active'::pgboss.job_state,
              started_on = now() - interval '20 minutes',
              retry_count = retry_limit
          WHERE id = $1 AND name = $2
        `,
        [firstJobId, GOOGLE_SYNC_QUEUE]
      );

      const dedupedJobId = await sendJob(boss, GOOGLE_SYNC_QUEUE, payload, {
        singletonKey: actorUserId
      });
      expect(dedupedJobId).toBeNull();

      await boss.supervise(GOOGLE_SYNC_QUEUE);

      const stranded = await adminClient.query<{ state: string }>(
        `SELECT state FROM pgboss.job WHERE id = $1`,
        [firstJobId]
      );
      expect(stranded.rows[0]?.state).not.toBe("active");

      const recoveredJobId = await sendJob(boss, GOOGLE_SYNC_QUEUE, payload, {
        singletonKey: actorUserId
      });
      expect(recoveredJobId).toEqual(expect.any(String));
    } finally {
      await adminClient.query(`DELETE FROM pgboss.job WHERE name = $1 AND singleton_key = $2`, [
        GOOGLE_SYNC_QUEUE,
        actorUserId
      ]);
    }
  });
});
