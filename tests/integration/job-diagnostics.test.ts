import { randomUUID } from "node:crypto";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, readJobDiagnostics } from "@moss/jobs";
import type { Kysely } from "kysely";
import pg from "pg";
import type { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;
const QUEUE = "diag.test-queue";
const OTHER_QUEUE = "diag.other-queue";
const SWEEP_QUEUE = "diag.sweep-queue";
const MARKER = "SECRET-MARKER";

async function bootstrap(text: string, values: unknown[] = []): Promise<pg.QueryResult> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    return await client.query(text, values);
  } finally {
    await client.end();
  }
}

describe("job diagnostics reader", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    dataContext = new DataContextRunner(appDb);
    boss = createPgBossClient(connectionStrings.worker, { connectionTimeoutMillis: 25_000 });
    await boss.start();
    for (const name of [QUEUE, OTHER_QUEUE, SWEEP_QUEUE]) await boss.createQueue(name);
  }, 120_000);

  afterAll(async () => {
    await boss.stop({ graceful: false });
    await appDb.destroy();
  });

  async function insertJob(
    queue: string,
    data: Record<string, unknown> | null,
    patch: { state?: string; output?: unknown; startedAgoSeconds?: number; retryCount?: number }
  ): Promise<string> {
    const id = randomUUID();
    await bootstrap(
      `INSERT INTO pgboss.job (id, name, data, state, retry_count, output, started_on, completed_on, start_after)
       VALUES ($1, $2, $3::jsonb, $4::pgboss.job_state, $5, $6::jsonb,
         CASE WHEN $7::int IS NULL THEN NULL ELSE now() - ($7::int * interval '1 second') END,
         CASE WHEN $4 IN ('completed', 'failed') THEN now() ELSE NULL END,
         CASE WHEN $4 IN ('created', 'retry') AND $7::int IS NOT NULL
           THEN now() - ($7::int * interval '1 second') ELSE now() END)`,
      [
        id,
        queue,
        data === null ? null : JSON.stringify(data),
        patch.state ?? "failed",
        patch.retryCount ?? 0,
        patch.output === undefined ? null : JSON.stringify(patch.output),
        patch.startedAgoSeconds ?? null
      ]
    );
    return id;
  }

  async function clear(): Promise<void> {
    await bootstrap("DELETE FROM pgboss.job WHERE name = ANY($1)", [
      [QUEUE, OTHER_QUEUE, SWEEP_QUEUE]
    ]);
  }

  function read(actor: string, options: { limit?: number; queuePrefix?: string } = {}) {
    return dataContext.withDataContext({ actorUserId: actor, requestId: "job-diag" }, (scoped) =>
      readJobDiagnostics(scoped.db, {
        actorUserId: actor,
        limit: options.limit ?? 10,
        queuePrefix: options.queuePrefix,
        since: new Date(Date.now() - 24 * 60 * 60 * 1000)
      })
    );
  }

  it("1 and 8. shows an owned failed job's kind and state, read as the app runtime role", async () => {
    await clear();
    await insertJob(
      QUEUE,
      { actorUserId: ids.userA, kind: "sync", connectorAccountId: "acct-1" },
      { state: "failed", retryCount: 2 }
    );
    const section = await read(ids.userA, { queuePrefix: QUEUE });
    expect(section.recent).toHaveLength(1);
    expect(section.recent[0]).toMatchObject({
      queue: QUEUE,
      state: "failed",
      retryCount: 2,
      ownerKnown: true,
      kind: "sync",
      connectorAccountId: "acct-1",
      errorLabel: "failed"
    });
    expect(section.summaries[0]).toMatchObject({ queue: QUEUE, failedLast24h: 1 });
  });

  it("2. shows another user's job as queue, state and times only", async () => {
    await clear();
    await insertJob(
      QUEUE,
      { actorUserId: ids.userB, kind: "private-kind", connectorAccountId: "acct-b" },
      { state: "failed" }
    );
    const section = await read(ids.userA, { queuePrefix: QUEUE });
    expect(section.recent).toHaveLength(1);
    expect(section.recent[0]).toMatchObject({
      queue: QUEUE,
      state: "failed",
      ownerKnown: false,
      kind: null,
      connectorAccountId: null
    });
    expect(JSON.stringify(section)).not.toContain("private-kind");
    expect(JSON.stringify(section)).not.toContain("acct-b");
  });

  it("3. never returns private payload content", async () => {
    await clear();
    await insertJob(
      QUEUE,
      { actorUserId: ids.userA, kind: "sync", params: { note: MARKER } },
      { state: "failed" }
    );
    await insertJob(
      QUEUE,
      { actorUserId: ids.userB, kind: "sync", params: { note: MARKER } },
      { state: "failed" }
    );
    const section = await read(ids.userA, { queuePrefix: QUEUE });
    expect(section.recent).toHaveLength(2);
    expect(JSON.stringify(section)).not.toContain(MARKER);
  });

  it("4. returns a fixed label, never the failure output text", async () => {
    await clear();
    await insertJob(
      QUEUE,
      { actorUserId: ids.userA, kind: "sync" },
      { state: "failed", output: { message: MARKER } }
    );
    const section = await read(ids.userA, { queuePrefix: QUEUE });
    expect(section.recent[0]?.errorLabel).toBe("failed");
    expect(JSON.stringify(section)).not.toContain(MARKER);
  });

  it("5. caps the list at the limit and flags truncation", async () => {
    await clear();
    for (let i = 0; i < 4; i += 1) {
      await insertJob(QUEUE, { actorUserId: ids.userA, kind: "sync" }, { state: "completed" });
    }
    const section = await read(ids.userA, { limit: 3, queuePrefix: QUEUE });
    expect(section.recent).toHaveLength(3);
    expect(section.truncated).toBe(true);
    const full = await read(ids.userA, { limit: 10, queuePrefix: QUEUE });
    expect(full.truncated).toBe(false);
  });

  it("6. counts a stuck active job and not a recent one", async () => {
    await clear();
    await insertJob(
      QUEUE,
      { actorUserId: ids.userA, kind: "sync" },
      { state: "active", startedAgoSeconds: 3600 }
    );
    await insertJob(
      QUEUE,
      { actorUserId: ids.userA, kind: "sync" },
      { state: "active", startedAgoSeconds: 5 }
    );
    const section = await read(ids.userA, { queuePrefix: QUEUE });
    expect(section.summaries[0]).toMatchObject({ queue: QUEUE, stuckCount: 1, activeCount: 2 });
  });

  it("7. counts ownerless scheduled sweeps but lists them as owner unknown", async () => {
    await clear();
    await insertJob(SWEEP_QUEUE, null, { state: "failed" });
    await insertJob(SWEEP_QUEUE, { sweep: true }, { state: "completed" });
    const section = await read(ids.userA, { queuePrefix: SWEEP_QUEUE });
    expect(section.recent).toHaveLength(2);
    expect(section.recent.every((row) => !row.ownerKnown && row.kind === null)).toBe(true);
    expect(section.summaries[0]).toMatchObject({ queue: SWEEP_QUEUE, failedLast24h: 1 });
    expect(section.summaries[0]?.lastSuccessAt).not.toBeNull();
  });

  it("filters by queue prefix and treats wildcard characters literally", async () => {
    await clear();
    await insertJob(QUEUE, { actorUserId: ids.userA, kind: "a" }, { state: "failed" });
    await insertJob(OTHER_QUEUE, { actorUserId: ids.userA, kind: "b" }, { state: "failed" });
    expect((await read(ids.userA, { queuePrefix: OTHER_QUEUE })).recent).toHaveLength(1);
    expect((await read(ids.userA, { queuePrefix: "diag.%" })).recent).toHaveLength(0);
  });
});
