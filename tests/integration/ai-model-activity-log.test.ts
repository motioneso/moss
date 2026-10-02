import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { AiRepository } from "@moss/ai";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * Plan 3.6a (#2889): the model activity log's row security and its admin-gated read endpoint.
 * Rows here are inserted directly (the recording path itself is covered in
 * tests/unit/ai-model-activity-recording.test.ts); this file proves what a non-admin can and
 * cannot reach, that the table cannot carry message text, and that old rows stay readable.
 */
describe("model activity log (#2889)", () => {
  let appDb: Kysely<MossDatabase>;
  let server: ReturnType<typeof createApiServer>;
  let boss: PgBoss;

  beforeAll(async () => {
    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 3 });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();

    const repository = new AiRepository();
    await repository.insertModelActivity(appDb, {
      kind: "chat",
      action: "chat",
      outcome: "ok",
      modelName: "uat-model-alpha",
      result: "completed"
    });
    await repository.insertModelActivity(appDb, {
      kind: "structured",
      action: "briefings",
      outcome: "error",
      modelName: "uat-model-beta",
      result: "failed"
    });
    await repository.insertModelActivity(appDb, {
      kind: "chat",
      action: "chat",
      outcome: "ok",
      modelName: "uat-model-alpha",
      result: "completed",
      // 400 days old: kept indefinitely, so it must still be returned.
      occurredAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000)
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("the table has exactly the six recorded fields and no message-text column", async () => {
    const result = await sql<{ column_name: string }>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'app' AND table_name = 'moss_model_activity_log'
      ORDER BY column_name
    `.execute(appDb);

    expect(result.rows.map((row) => row.column_name)).toEqual([
      "action",
      "id",
      "kind",
      "model_name",
      "occurred_at",
      "outcome",
      "result"
    ]);
  });

  it("row security hides the log from a non-admin even with a direct query", async () => {
    const runner = new DataContextRunner(appDb);
    const rows = await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      scopedDb.db.selectFrom("app.moss_model_activity_log").selectAll().execute()
    );
    expect(rows).toHaveLength(0);
  });

  it("row security shows the log to an instance admin", async () => {
    const runner = new DataContextRunner(appDb);
    const rows = await runner.withDataContext({ actorUserId: ids.adminUser }, (scopedDb) =>
      scopedDb.db.selectFrom("app.moss_model_activity_log").selectAll().execute()
    );
    expect(rows).toHaveLength(3);
  });

  it("rejects a non-admin on the endpoint with 403", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(res.statusCode).toBe(403);
  });

  it("returns entries to an admin, newest first, including a 400-day-old row", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ occurredAt: string; kind: string; modelName: string; result: string }>;
      nextBefore: string | null;
    };
    expect(body.entries).toHaveLength(3);
    expect(new Date(body.entries[0]!.occurredAt).getTime()).toBeGreaterThan(
      new Date(body.entries[1]!.occurredAt).getTime()
    );
    const oldest = body.entries[2]!;
    expect(Date.now() - new Date(oldest.occurredAt).getTime()).toBeGreaterThan(
      399 * 24 * 60 * 60 * 1000
    );
    expect(body.nextBefore).toBeNull();
  });

  it("filters by kind, model and result", async () => {
    const kindRes = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity?kind=structured",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect((kindRes.json() as { entries: unknown[] }).entries).toHaveLength(1);

    const modelRes = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity?model=uat-model-alpha",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect((modelRes.json() as { entries: unknown[] }).entries).toHaveLength(2);

    const resultRes = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity?result=error",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect((resultRes.json() as { entries: unknown[] }).entries).toHaveLength(1);
  });

  it("filters by time and pages older with the before cursor", async () => {
    const recentSince = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const sinceRes = await server.inject({
      method: "GET",
      url: `/api/ai/model-activity?since=${encodeURIComponent(recentSince)}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect((sinceRes.json() as { entries: unknown[] }).entries).toHaveLength(2);

    const pageOne = await server.inject({
      method: "GET",
      url: "/api/ai/model-activity?limit=2",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    const pageOneBody = pageOne.json() as {
      entries: unknown[];
      nextBefore: string | null;
    };
    expect(pageOneBody.entries).toHaveLength(2);
    expect(pageOneBody.nextBefore).not.toBeNull();

    const pageTwo = await server.inject({
      method: "GET",
      url: `/api/ai/model-activity?limit=2&before=${encodeURIComponent(pageOneBody.nextBefore!)}`,
      headers: { authorization: `Bearer ${ids.sessionAdmin}` }
    });
    expect((pageTwo.json() as { entries: unknown[] }).entries).toHaveLength(1);
  });
});
