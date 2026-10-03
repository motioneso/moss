import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { AiRepository } from "@moss/ai";
import type { ActionAuditLogEntryDto, ActivityLineDto } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

/**
 * #2956 (slice C): the owner-scoped activity-lines endpoint. Each person reads their own
 * lines with unexpired detail; expired detail arrives null; admins additionally read
 * ownerless System lines; and tool rows carry the turn id that joins them to their answer.
 */
describe("activity lines endpoint (#2956)", () => {
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
    const runner = new DataContextRunner(appDb);

    // User A's chat answer with quoted detail.
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      repository.insertModelActivity(scopedDb.db, {
        kind: "chat",
        action: "chat",
        outcome: "ok",
        modelName: "uat-model-alpha",
        result: "completed",
        ownerUserId: ids.userA,
        actionCode: "chat.answer",
        turnId: "uat-turn-lines-a",
        durationMs: 6200,
        inputTokens: 4120,
        outputTokens: 96,
        factCounts: { tools: 2, jev_agreed: true },
        detail: {
          quote: "Turn on the kitchen light",
          resultLine: "Turned on the kitchen light.",
          steps: [{ title: "Answer", result: "Done." }]
        }
      })
    );

    // User A's tool row in the same turn.
    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "req-lines-a" },
      async (scopedDb) => {
        await repository.insertActionAuditLog(scopedDb, {
          id: randomUUID(),
          ownerUserId: ids.userA,
          toolModuleId: "home-assistant",
          toolName: "home-assistant.HassTurnOn",
          actionFamilyId: null,
          actionKind: "write",
          approvalMode: "auto",
          outcome: "success",
          durationMs: 800,
          errorClass: null,
          requestId: "req-lines-a",
          chatSessionId: "session-lines-a",
          turnId: "uat-turn-lines-a",
          sourceSurface: "chat",
          inputSummary: null
        });
      }
    );

    // User B's line: never visible to user A.
    await runner.withDataContext({ actorUserId: ids.userB }, (scopedDb) =>
      repository.insertModelActivity(scopedDb.db, {
        kind: "structured",
        action: "briefings",
        outcome: "ok",
        modelName: "uat-model-beta",
        result: "completed",
        ownerUserId: ids.userB,
        actionCode: "structured.briefings"
      })
    );

    // A System line: ownerless, visible to admins only.
    await repository.insertModelActivity(appDb, {
      kind: "chat",
      action: "probe",
      outcome: "ok",
      modelName: "uat-model-alpha",
      result: "completed",
      actionCode: "probe.reachable"
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  async function getLines(
    session: string
  ): Promise<{ status: number; entries: ActivityLineDto[] }> {
    const res = await server.inject({
      method: "GET",
      url: "/api/ai/activity-lines?limit=200",
      headers: { authorization: `Bearer ${session}` }
    });
    return {
      status: res.statusCode,
      entries: (res.json() as { entries: ActivityLineDto[] }).entries
    };
  }

  it("shows a person their own lines with unexpired detail, and nobody else's", async () => {
    const { status, entries } = await getLines(ids.sessionA);
    expect(status).toBe(200);
    expect(entries).toHaveLength(1);
    const line = entries[0]!;
    expect(line.actionCode).toBe("chat.answer");
    expect(line.turnId).toBe("uat-turn-lines-a");
    expect(line.durationMs).toBe(6200);
    expect(line.inputTokens).toBe(4120);
    expect(line.factCounts).toEqual({ tools: 2, jev_agreed: true });
    expect(line.detail?.quote).toBe("Turn on the kitchen light");
    expect(line.detail?.resultLine).toBe("Turned on the kitchen light.");
    expect(line.detail?.steps).toHaveLength(1);
    expect(line.detail?.expiresAt).toBeTruthy();
  });

  it("shows an admin their own lines plus System lines, and nobody else's", async () => {
    const { status, entries } = await getLines(ids.sessionAdmin);
    expect(status).toBe(200);
    // Only the ownerless System line: the admin owns no line in this file.
    expect(entries).toHaveLength(1);
    expect(entries[0]!.ownerUserId).toBeNull();
    expect(entries[0]!.actionCode).toBe("probe.reachable");
  });

  it("carries the turn id on tool rows so the page can join them to their answer", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/ai/action-audit?limit=200",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(res.statusCode).toBe(200);
    const entries = (res.json() as { entries: ActionAuditLogEntryDto[] }).entries;
    const tool = entries.find((entry) => entry.toolName === "home-assistant.HassTurnOn");
    expect(tool?.turnId).toBe("uat-turn-lines-a");
  });

  it("returns bare rows with null detail once the quoted words expire", async () => {
    const expiredId = randomUUID();
    const runner = new DataContextRunner(appDb);
    await runner.withDataContext({ actorUserId: ids.userA }, (scopedDb) =>
      (async () => {
        await sql`
          INSERT INTO app.moss_model_activity_log
            (id, kind, action, outcome, model_name, result, owner_user_id, action_code)
          VALUES (${expiredId}, 'chat', 'chat', 'ok', 'uat-model-alpha', 'completed', ${ids.userA}, 'chat.answer')
        `.execute(scopedDb.db);
        await sql`
          INSERT INTO app.moss_activity_detail
            (activity_id, owner_user_id, quote, steps, expires_at)
          VALUES (${expiredId}, ${ids.userA}, 'already expired', '[]'::jsonb, now() - interval '1 day')
        `.execute(scopedDb.db);
      })()
    );

    const { status, entries } = await getLines(ids.sessionA);
    expect(status).toBe(200);
    const expired = entries.find((entry) => entry.id === expiredId);
    expect(expired).toBeDefined();
    expect(expired!.detail).toBeNull();
  });
});
