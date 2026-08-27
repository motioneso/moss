import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { sql, type Kysely } from "kysely";

import { createDatabase, DataContextRunner, type AccessContext, type MossDatabase } from "@moss/db";
import {
  buildCalendarFollowThroughSideEffects,
  getBuiltInModuleManifests,
  getBuiltInModuleRegistrations
} from "@moss/module-registry";
import { CalendarRepository, calendarFollowThroughSourceRef } from "@moss/calendar";
import { ConnectorsRepository, createConnectorSecretCipher } from "@moss/connectors";
import { TasksRepository } from "@moss/tasks";
import { ChatRepository, createChatFeedbackTargetVerifier } from "../../packages/chat/src/index.js";
import { deriveBriefingFeedbackItems } from "../../packages/briefings/src/index.js";
import { UsefulnessFeedbackRepository } from "../../packages/usefulness-feedback/src/repository.js";
import { exportUserData } from "../../scripts/export-user-data.js";

import {
  buildFeedbackTestServer,
  rememberableVerifier,
  userAContext,
  userAHeaders
} from "./usefulness-feedback-helpers.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

let appDb: Kysely<MossDatabase>;

interface MemoryCandidateTestRow {
  readonly id: string;
  readonly kind: string;
  readonly action: string;
  readonly payload_json: unknown;
  readonly status: string;
  readonly confidence: string | number;
  readonly importance: string | number;
  readonly provenance: string;
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("usefulness feedback foundation", () => {
  it("registers the required module and applies owner-only RLS without runtime delete", async () => {
    expect(getBuiltInModuleManifests().map((manifest) => manifest.id)).toContain(
      "usefulness-feedback"
    );
    const registration = getBuiltInModuleRegistrations().find(
      (item) => item.manifest.id === "usefulness-feedback"
    );

    expect(registration?.manifest.database?.ownedTables).toEqual([
      "app.usefulness_feedback_signals",
      "app.usefulness_feedback_targets"
    ]);
    expect(registration?.manifest.routes?.map((route) => `${route.method} ${route.path}`)).toEqual([
      "POST /api/me/usefulness-feedback",
      "GET /api/me/usefulness-feedback",
      "PATCH /api/me/usefulness-feedback/:id",
      "POST /api/me/usefulness-feedback/:id/undo"
    ]);

    const client = new Client({ connectionString: connectionStrings.migration });
    await client.connect();
    try {
      const result = await client.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
        app_can_delete: boolean;
        worker_can_delete: boolean;
      }>(`
        SELECT
          c.relname,
          c.relrowsecurity,
          c.relforcerowsecurity,
          has_table_privilege('jarvis_app_runtime', c.oid, 'DELETE') AS app_can_delete,
          has_table_privilege('jarvis_worker_runtime', c.oid, 'DELETE') AS worker_can_delete
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'app'
          AND c.relname IN ('usefulness_feedback_signals', 'usefulness_feedback_targets')
        ORDER BY c.relname
      `);

      expect(result.rows).toEqual([
        {
          relname: "usefulness_feedback_signals",
          relrowsecurity: true,
          relforcerowsecurity: true,
          app_can_delete: false,
          worker_can_delete: false
        },
        {
          relname: "usefulness_feedback_targets",
          relrowsecurity: true,
          relforcerowsecurity: true,
          app_can_delete: false,
          worker_can_delete: false
        }
      ]);
    } finally {
      await client.end();
    }
  });
});

describe("usefulness feedback routes", () => {
  it("rejects invalid target/action pairs, target/surface pairs, and unknown top-level keys", async () => {
    const { server } = await buildFeedbackTestServer(appDb);
    try {
      const invalidAction = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-a",
          surface: "chat",
          kind: "dismiss"
        }
      });
      expect(invalidAction.statusCode).toBe(400);

      const invalidSurface = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-a",
          surface: "today",
          kind: "not_useful"
        }
      });
      expect(invalidSurface.statusCode).toBe(400);

      const extraKey = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-a",
          surface: "chat",
          kind: "not_useful",
          extra: true
        }
      });
      expect(extraKey.statusCode).toBe(400);
    } finally {
      await server.close();
    }
  });

  it("creates idempotent active feedback before repeating verifier side effects and undoes it", async () => {
    let calls = 0;
    const { server } = await buildFeedbackTestServer(appDb, async () => {
      calls += 1;
      return {
        ownerUserId: userAContext().actorUserId,
        targetKind: "chat_message",
        targetRef: "msg-a",
        surface: "chat",
        sourceKind: "chat",
        sourceLabel: "Chat",
        priorityBand: "normal",
        metadata: { role: "assistant" },
        canRemember: false
      };
    });
    try {
      const payload = {
        targetKind: "chat_message",
        targetRef: "msg-a",
        surface: "chat",
        kind: "not_useful"
      };
      const first = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload
      });
      const second = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(second.json().feedback.id).toBe(first.json().feedback.id);
      expect(calls).toBe(1);

      const undo = await server.inject({
        method: "POST",
        url: `/api/me/usefulness-feedback/${first.json().feedback.id}/undo`,
        headers: userAHeaders()
      });
      expect(undo.statusCode).toBe(200);
      expect(undo.json().feedback.status).toBe("undone");
      expect(undo.json().feedback.resolvedAt).toEqual(expect.any(String));
    } finally {
      await server.close();
    }
  });

  it("remember_this creates one pending memory candidate without storing excerpt on feedback", async () => {
    const { server, dataContext } = await buildFeedbackTestServer(
      appDb,
      rememberableVerifier("remember me safely")
    );
    try {
      const payload = {
        targetKind: "chat_message",
        targetRef: "msg-memory",
        surface: "chat",
        kind: "remember_this"
      };
      const first = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload
      });
      const second = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload
      });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(200);
      expect(first.json().feedback.effectKind).toBe("memory_candidate");
      expect(JSON.stringify(first.json().feedback)).not.toContain("remember me safely");

      const candidates = await dataContext.withDataContext(
        userAContext(),
        async (scopedDb) =>
          (
            await sql<MemoryCandidateTestRow>`
            SELECT id, kind, action, payload_json, status, confidence, importance, provenance
            FROM app.memory_candidates
            WHERE owner_user_id = ${ids.userA}::uuid
          `.execute(scopedDb.db)
          ).rows
      );
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        status: "pending",
        kind: "fact",
        action: "create",
        confidence: "0.500",
        importance: "0.500",
        provenance: "volunteered"
      });
      expect(candidates[0]?.payload_json).toMatchObject({
        manualRequest: true,
        excerpt: "remember me safely",
        targetKind: "chat_message",
        targetRef: "msg-memory"
      });
    } finally {
      await server.close();
    }
  });

  it("undo of pending remember_this suppresses the linked memory candidate", async () => {
    const { server, dataContext } = await buildFeedbackTestServer(
      appDb,
      rememberableVerifier("cancel me")
    );
    try {
      const created = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-cancel",
          surface: "chat",
          kind: "remember_this"
        }
      });
      expect(created.statusCode).toBe(201);

      const undone = await server.inject({
        method: "POST",
        url: `/api/me/usefulness-feedback/${created.json().feedback.id}/undo`,
        headers: userAHeaders()
      });
      expect(undone.statusCode).toBe(200);

      const candidate = await dataContext.withDataContext(
        userAContext(),
        async (scopedDb) =>
          (
            await sql<MemoryCandidateTestRow>`
            SELECT id, kind, action, payload_json, status, confidence, importance, provenance
            FROM app.memory_candidates
            WHERE id = ${created.json().feedback.effectRef}::uuid
          `.execute(scopedDb.db)
          ).rows[0]
      );
      expect(candidate?.status).toBe("suppressed");
    } finally {
      await server.close();
    }
  });

  it("verifies chat messages through the chat-owned verifier and rejects other owners/incognito remember", async () => {
    const chatRepository = new ChatRepository();
    const userAMessages = await createStoredChatTurn(chatRepository, userAContext());
    const userBMessages = await createStoredChatTurn(chatRepository, {
      actorUserId: ids.userB,
      requestId: "req:feedback-b"
    });
    const incognitoThread = await createIncognitoThread(chatRepository, userAContext());
    const { server } = await buildFeedbackTestServer(
      appDb,
      createChatFeedbackTargetVerifier(chatRepository)
    );
    try {
      const own = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: userAMessages.assistantMessage.id,
          surface: "chat",
          kind: "not_useful"
        }
      });
      expect(own.statusCode).toBe(201);

      const otherOwner = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: userBMessages.assistantMessage.id,
          surface: "chat",
          kind: "not_useful"
        }
      });
      expect(otherOwner.statusCode).toBe(404);

      const incognitoRemember = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: incognitoThread.id,
          surface: "chat",
          kind: "remember_this"
        }
      });
      expect(incognitoRemember.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("fails closed for unregistered target verifiers", async () => {
    const { server } = await buildFeedbackTestServer(appDb);
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "proactive_card",
          targetRef: "proactive-missing",
          surface: "proactive",
          kind: "not_useful"
        }
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("keeps unsafe verifier metadata and remember excerpts out of feedback rows", async () => {
    const { server, dataContext } = await buildFeedbackTestServer(
      appDb,
      async (_scopedDb, input) => ({
        ownerUserId: input.actorUserId,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        surface: input.surface,
        sourceKind: "chat",
        sourceLabel: "Chat",
        metadata: {
          role: "user",
          prompt: "prompt sentinel",
          body: "body sentinel",
          sourceIds: ["source-id-sentinel"],
          nested: { signalType: "manual", secret: "secret sentinel" }
        },
        canRemember: true,
        rememberExcerpt: "remember excerpt sentinel"
      })
    );
    try {
      const response = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-unsafe-metadata",
          surface: "chat",
          kind: "remember_this"
        }
      });
      expect(response.statusCode).toBe(201);

      const rows = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
        scopedDb.db
          .selectFrom("app.usefulness_feedback_signals")
          .select(["metadata_json", "effect_kind", "effect_ref"])
          .where("id", "=", response.json().feedback.id)
          .execute()
      );
      const serialized = JSON.stringify(rows[0]);
      expect(rows[0]?.metadata_json).toMatchObject({
        role: "user",
        nested: { signalType: "manual" }
      });
      expect(serialized).not.toContain("prompt sentinel");
      expect(serialized).not.toContain("body sentinel");
      expect(serialized).not.toContain("source-id-sentinel");
      expect(serialized).not.toContain("secret sentinel");
      expect(serialized).not.toContain("remember excerpt sentinel");
      expect(rows[0]?.effect_kind).toBe("memory_candidate");
    } finally {
      await server.close();
    }
  });

  it("enforces owner isolation for list, undo, and admin-scoped reads", async () => {
    const repository = new UsefulnessFeedbackRepository();
    const dataContext = new DataContextRunner(appDb);
    const userBContext: AccessContext = { actorUserId: ids.userB, requestId: "req:feedback-b" };
    const userBFeedback = await dataContext.withDataContext(userBContext, (scopedDb) =>
      repository.create(scopedDb, {
        ownerUserId: ids.userB,
        targetKind: "chat_message",
        targetRef: "msg-user-b-private",
        surface: "chat",
        kind: "not_useful",
        verification: {
          ownerUserId: ids.userB,
          targetKind: "chat_message",
          targetRef: "msg-user-b-private",
          surface: "chat",
          canRemember: false
        },
        metadata: { role: "assistant" }
      })
    );

    const { server } = await buildFeedbackTestServer(appDb, async (_scopedDb, input) => {
      if (input.targetRef === "msg-user-b-private") return null;
      return {
        ownerUserId: input.actorUserId,
        targetKind: input.targetKind,
        targetRef: input.targetRef,
        surface: input.surface,
        canRemember: false
      };
    });
    try {
      const createOther = await server.inject({
        method: "POST",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders(),
        payload: {
          targetKind: "chat_message",
          targetRef: "msg-user-b-private",
          surface: "chat",
          kind: "not_useful"
        }
      });
      expect(createOther.statusCode).toBe(404);

      const list = await server.inject({
        method: "GET",
        url: "/api/me/usefulness-feedback",
        headers: userAHeaders()
      });
      expect(list.statusCode).toBe(200);
      expect(JSON.stringify(list.json())).not.toContain(userBFeedback.id);

      const undoOther = await server.inject({
        method: "POST",
        url: `/api/me/usefulness-feedback/${userBFeedback.id}/undo`,
        headers: userAHeaders()
      });
      expect(undoOther.statusCode).toBe(404);

      const adminRows = await dataContext.withDataContext(
        { actorUserId: ids.adminUser, requestId: "req:feedback-admin" },
        (scopedDb) =>
          scopedDb.db
            .selectFrom("app.usefulness_feedback_signals")
            .selectAll()
            .where("owner_user_id", "=", ids.userB)
            .execute()
      );
      expect(adminRows).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("exports owner feedback signals and targets only as metadata rows", async () => {
    const repository = new UsefulnessFeedbackRepository();
    const dataContext = new DataContextRunner(appDb);
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      await repository.upsertTarget(scopedDb, {
        ownerUserId: ids.userA,
        targetKind: "briefing_item",
        targetRef: "email:needs_reply:abcdef1234567890",
        surface: "briefing",
        sourceKind: "email",
        sourceLabel: "Email",
        priorityBand: "high",
        metadata: { signalType: "needs_reply" }
      });
      await repository.create(scopedDb, {
        ownerUserId: ids.userA,
        targetKind: "briefing_item",
        targetRef: "email:needs_reply:abcdef1234567890",
        surface: "briefing",
        kind: "dismiss",
        verification: {
          ownerUserId: ids.userA,
          targetKind: "briefing_item",
          targetRef: "email:needs_reply:abcdef1234567890",
          surface: "briefing",
          sourceKind: "email",
          sourceLabel: "Email",
          priorityBand: "high",
          canRemember: false
        },
        metadata: { signalType: "needs_reply" }
      });
    });

    await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:feedback-export-b" },
      async (scopedDb) => {
        await repository.upsertTarget(scopedDb, {
          ownerUserId: ids.userB,
          targetKind: "briefing_item",
          targetRef: "email:needs_reply:bbbbbbbbbbbbbbbb",
          surface: "briefing",
          sourceKind: "email",
          sourceLabel: "Email",
          metadata: { signalType: "needs_reply" }
        });
        await repository.create(scopedDb, {
          ownerUserId: ids.userB,
          targetKind: "briefing_item",
          targetRef: "email:needs_reply:bbbbbbbbbbbbbbbb",
          surface: "briefing",
          kind: "dismiss",
          verification: {
            ownerUserId: ids.userB,
            targetKind: "briefing_item",
            targetRef: "email:needs_reply:bbbbbbbbbbbbbbbb",
            surface: "briefing",
            sourceKind: "email",
            sourceLabel: "Email",
            canRemember: false
          },
          metadata: { signalType: "needs_reply" }
        });
      }
    );

    const userExport = await exportUserData({
      appConnectionString: connectionStrings.app,
      exportedAt: new Date("2026-06-27T12:00:00.000Z"),
      userId: ids.userA
    });
    const exportedJson = JSON.stringify(userExport);

    expect(userExport.tables.usefulnessFeedbackTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerUserId: ids.userA,
          targetKind: "briefing_item",
          targetRef: "email:needs_reply:abcdef1234567890",
          metadata: { signalType: "needs_reply" }
        })
      ])
    );
    expect(userExport.tables.usefulnessFeedbackSignals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownerUserId: ids.userA,
          targetKind: "briefing_item",
          targetRef: "email:needs_reply:abcdef1234567890",
          kind: "dismiss",
          metadata: { signalType: "needs_reply" }
        })
      ])
    );
    expect(exportedJson).not.toContain("bbbbbbbbbbbbbbbb");
    expect(exportedJson).not.toContain("prompt sentinel");
    expect(exportedJson).not.toContain("body sentinel");
    expect(exportedJson).not.toContain("remember excerpt sentinel");
    expect(exportedJson).not.toContain("remember me safely");
    expect(exportedJson).not.toContain("cancel me");
    expect(Object.keys(userExport.tables.usefulnessFeedbackSignals[0] ?? {})).not.toContain(
      "summaryText"
    );
  });

  it("merges briefing target metadata so recomposition preserves Calendar refs", async () => {
    const repository = new UsefulnessFeedbackRepository();
    const dataContext = new DataContextRunner(appDb);
    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      await repository.upsertTarget(scopedDb, {
        ownerUserId: ids.userA,
        targetKind: "briefing_item",
        targetRef: "calendar:prep:merge",
        surface: "briefing",
        sourceKind: "calendar",
        sourceLabel: "Calendar",
        metadata: {
          calendarFollowThrough: {
            targetRef: "calendar:prep:merge",
            calendarEventId: "calendar-event-1"
          }
        }
      });
      await repository.upsertTarget(scopedDb, {
        ownerUserId: ids.userA,
        targetKind: "briefing_item",
        targetRef: "calendar:prep:merge",
        surface: "briefing",
        sourceKind: "calendar",
        sourceLabel: "Calendar",
        metadata: { signalType: "prep_needed" }
      });

      const target = await repository.findTarget(
        scopedDb,
        ids.userA,
        "briefing_item",
        "calendar:prep:merge",
        "briefing"
      );
      expect(target?.metadata_json).toMatchObject({
        signalType: "prep_needed",
        calendarFollowThrough: {
          targetRef: "calendar:prep:merge",
          calendarEventId: "calendar-event-1"
        }
      });
    });
  });

  it("removes both Calendar-created refs and denies cross-user refs", async () => {
    const dataContext = new DataContextRunner(appDb);
    const tasks = new TasksRepository();
    const calendar = new CalendarRepository();
    const connectors = new ConnectorsRepository();
    const cipher = createConnectorSecretCipher();
    const targetRef = "calendar:prep:both";
    const sourceRef = calendarFollowThroughSourceRef(targetRef);
    let deletedEventId: string | null = null;

    const refs = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const account = await connectors.upsertGoogleAccount(scopedDb, {
        scopes: ["https://www.googleapis.com/auth/calendar"],
        encryptedSecret: cipher.encryptJson({ kind: "google-oauth" })
      });
      const task = await tasks.create(scopedDb, {
        title: "Prep",
        status: "todo",
        source: "calendar",
        sourceRef,
        externalKey: sourceRef
      });
      const event = await calendar.upsertCachedEvent(scopedDb, {
        connectorAccountId: account.id,
        externalId: "google-event-both",
        title: "Prep time",
        startsAt: "2026-07-04T09:00:00.000Z",
        endsAt: "2026-07-04T10:00:00.000Z",
        externalMetadata: { jarvisCreated: true, followThroughTargetRef: targetRef }
      });
      return { taskId: task.id, calendarEventId: event.id };
    });

    const sideEffects = buildCalendarFollowThroughSideEffects({
      calendarWrite: {
        deleteEvent: async (_scopedDb, _ctx, input) => {
          deletedEventId = input.eventId;
          return { deleted: true };
        }
      }
    });
    const metadata = { calendarFollowThrough: { targetRef, ...refs } };

    const denied = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:feedback-b" },
      (scopedDb) => sideEffects.removeCreatedRefs(scopedDb, ids.userB, metadata)
    );
    expect(denied).toBeNull();
    expect(deletedEventId).toBeNull();

    const removed = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      sideEffects.removeCreatedRefs(scopedDb, ids.userA, metadata)
    );
    expect(removed).toContain(`task:${refs.taskId}`);
    expect(removed).toContain(`calendar_event:${refs.calendarEventId}`);
    expect(deletedEventId).toBe(refs.calendarEventId);

    const archived = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      tasks.getById(scopedDb, refs.taskId)
    );
    expect(archived?.status).toBe("archived");
  });
});

describe("briefing feedback target helpers", () => {
  it("derives stable briefing item refs without exposing raw source ids or summary text", () => {
    const items = deriveBriefingFeedbackItems({
      calendarSignals: [
        {
          type: "time_sensitive",
          summary: "Private appointment with raw source event cal_evt_123",
          eventIds: ["cal_evt_123"]
        }
      ],
      emailSignals: [
        {
          type: "needs_reply",
          summary: "Private sender needs a reply",
          messageIds: ["email_msg_456"]
        }
      ]
    });

    expect(items).toHaveLength(2);
    expect(items[0]?.feedbackItemId).toMatch(/^calendar:time_sensitive:[a-f0-9]{16}$/);
    expect(items[1]?.feedbackItemId).toMatch(/^email:needs_reply:[a-f0-9]{16}$/);
    expect(JSON.stringify(items)).not.toContain("cal_evt_123");
    expect(JSON.stringify(items)).not.toContain("email_msg_456");
    expect(JSON.stringify(items)).not.toContain("Private appointment");
    expect(items[0]?.metadata).toEqual({ signalType: "time_sensitive" });
  });
});

async function createStoredChatTurn(repository: ChatRepository, access: AccessContext) {
  const dataContext = new DataContextRunner(appDb);
  return dataContext.withDataContext(access, async (scopedDb) => {
    const thread = await repository.openNewThread(scopedDb, { title: "Feedback chat" });
    const messages = await repository.recordCompletedTurn(
      scopedDb,
      thread.id,
      "remember this user-authored line",
      "assistant reply",
      { provider: "anthropic", model: "claude-test" }
    );
    if (!messages) throw new Error("chat test turn was not stored");
    return messages;
  });
}

async function createIncognitoThread(repository: ChatRepository, access: AccessContext) {
  const dataContext = new DataContextRunner(appDb);
  return dataContext.withDataContext(access, (scopedDb) =>
    repository.openNewThread(scopedDb, { title: "Feedback private", incognito: true })
  );
}
