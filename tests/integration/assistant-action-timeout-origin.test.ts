import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { ActionRequestRecovery } from "../../packages/ai/src/gateway/action-request-recovery.js";
import { createChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { surfaceSessionKey } from "../../packages/chat/src/live/chat-surface.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let db: Kysely<MossDatabase>;
let runner: DataContextRunner;
const actions = new AiRepository();
const chat = new ChatRepository();
const owner = { actorUserId: ids.userA };
const session = surfaceSessionKey(ids.userA, "drawer");

beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  runner = new DataContextRunner(db);
});
afterAll(async () => {
  await db?.destroy();
});

function createAction(threadId: string, expiresAt: Date) {
  return runner.withDataContext(owner, (scope) =>
    actions.createPendingAssistantAction(scope, {
      toolModuleId: "notes",
      toolModuleName: "Notes",
      toolName: "notes.edit",
      permissionId: "notes.edit",
      risk: "write",
      inputSummary: {},
      chatThreadId: threadId,
      chatSessionId: session,
      expiresAt
    })
  );
}

describe("durable timeout recovery through the real request and chat repositories", () => {
  it("expires A after restart and saves its timeout only in A while B stays selected", async () => {
    const a = await runner.withDataContext(owner, (scope) =>
      chat.openNewThread(scope, { title: "Request origin A" })
    );
    const request = await createAction(a.id, new Date(Date.now() + 100));
    await runner.withDataContext(owner, (scope) =>
      chat.recordCompletedTurn(
        scope,
        a.id,
        "A question",
        "A answer",
        { provider: "anthropic", model: "fixture" },
        {
          activityRecords: [
            {
              kind: "action_request",
              text: "Edit note",
              summary: "Edit note",
              actionRequestId: request.id
            }
          ]
        }
      )
    );
    const b = await runner.withDataContext(owner, (scope) =>
      chat.openNewThread(scope, { title: "Current conversation B" })
    );
    const beforeB = await runner.withDataContext(owner, (scope) => chat.listMessages(scope, b.id));
    const persistence = new DataContextChatPersistence({
      dataContext: runner,
      chatRepository: chat,
      aiRepository: actions
    });
    const manager = new ChatSessionManager({
      persistence,
      engineFactory: () => {
        throw new Error("Recovery must not launch a model");
      },
      personaFs: { mkdir: async () => {}, writeFile: async () => {} },
      clock: { now: () => Date.now() },
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "fixture"
    });
    const seen: TranscriptRecord[] = [];
    const unsubscribe = manager.subscribe(ids.userA, (record) => seen.push(record));
    const notifier = createChatGatewayNotifier(manager, runner, actions);
    // Fresh recovery has no prior gateway waiter or session memory, as after an API restart.
    const recovery = new ActionRequestRecovery({ runner, repository: actions, notifier });
    try {
      await new Promise((resolve) => setTimeout(resolve, 120));
      await recovery.recover(ids.userA);
      await recovery.recover(ids.userA);
      const stored = await runner.withDataContext(owner, (scope) =>
        actions.getAssistantAction(scope, request.id)
      );
      expect(stored).toMatchObject({
        status: "timed_out",
        chat_thread_id: a.id,
        chat_session_id: session
      });
      expect(stored?.resolved_at).not.toBeNull();
      expect(stored?.outcome_recorded_at).not.toBeNull();
      expect(
        await runner.withDataContext(owner, (scope) =>
          actions.listRecoverableAssistantActions(scope)
        )
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: request.id })]));
      expect(
        await runner.withDataContext(owner, (scope) => chat.getCurrentThread(scope, ids.userA))
      ).toMatchObject({ id: b.id });
      expect(
        await runner.withDataContext(owner, (scope) => chat.listMessages(scope, b.id))
      ).toEqual(beforeB);
      const history = (
        await runner.withDataContext(owner, (scope) => chat.listMessages(scope, a.id))
      ).map(serializeMessage);
      expect(history.map((message) => message.body)).toEqual(["A question", "A answer"]);
      const outcomes = history
        .flatMap((message) => message.activity)
        .filter(
          (record) => record.kind === "action_result" && record.actionRequestId === request.id
        );
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toMatchObject({ decidedBy: "timeout", outcome: "denied" });
      expect(seen).toEqual([]);
    } finally {
      recovery.dispose();
      unsubscribe();
    }
  });

  it("acknowledges only owned terminal history and keeps unwritten timeouts recoverable", async () => {
    const thread = await runner.withDataContext(owner, (scope) =>
      chat.openNewThread(scope, { title: "Unwritten timeout" })
    );
    const pending = await createAction(thread.id, new Date(Date.now() + 60_000));
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeRecorded(scope, pending.id)
    );
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeIgnored(scope, pending.id)
    );
    expect(
      (
        await runner.withDataContext(owner, (scope) =>
          actions.getAssistantAction(scope, pending.id)
        )
      )?.outcome_recorded_at
    ).toBeNull();
    const due = await createAction(thread.id, new Date(Date.now() - 1000));
    await runner.withDataContext(owner, (scope) => actions.expireAssistantAction(scope, due.id));
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await runner.withDataContext({ actorUserId }, (scope) =>
        actions.markAssistantActionOutcomeRecorded(scope, due.id)
      );
      await runner.withDataContext({ actorUserId }, (scope) =>
        actions.markAssistantActionOutcomeIgnored(scope, due.id)
      );
      expect(
        await runner.withDataContext({ actorUserId }, (scope) =>
          actions.listRecoverableAssistantActions(scope)
        )
      ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: due.id })]));
    }
    expect(
      await runner.withDataContext(owner, (scope) => actions.listRecoverableAssistantActions(scope))
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: due.id, outcome_recorded_at: null })])
    );
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeRecorded(scope, due.id)
    );
    const recorded = await runner.withDataContext(owner, (scope) =>
      actions.getAssistantAction(scope, due.id)
    );
    expect(recorded?.outcome_recorded_at).not.toBeNull();
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeRecorded(scope, due.id)
    );
    expect(
      (await runner.withDataContext(owner, (scope) => actions.getAssistantAction(scope, due.id)))
        ?.outcome_recorded_at
    ).toEqual(recorded?.outcome_recorded_at);
    expect(
      await runner.withDataContext(owner, (scope) => actions.listRecoverableAssistantActions(scope))
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: due.id })]));

    const ignored = await createAction(thread.id, new Date(Date.now() - 1000));
    await runner.withDataContext(owner, (scope) =>
      actions.expireAssistantAction(scope, ignored.id)
    );
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeIgnored(scope, ignored.id)
    );
    await runner.withDataContext(owner, (scope) =>
      actions.markAssistantActionOutcomeRecorded(scope, ignored.id)
    );
    const skipped = await runner.withDataContext(owner, (scope) =>
      actions.getAssistantAction(scope, ignored.id)
    );
    expect(skipped?.outcome_ignored_at).not.toBeNull();
    expect(skipped?.outcome_recorded_at).toBeNull();
    expect(
      await runner.withDataContext(owner, (scope) => actions.listRecoverableAssistantActions(scope))
    ).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: ignored.id })]));
  });

  it("enforces the deadline and pending compare-and-set in PostgreSQL", async () => {
    const thread = await runner.withDataContext(owner, (scope) =>
      chat.openNewThread(scope, { title: "Expiry CAS" })
    );
    const future = await createAction(thread.id, new Date(Date.now() + 60_000));
    expect(
      await runner.withDataContext(owner, (scope) =>
        actions.expireAssistantAction(scope, future.id)
      )
    ).toBeUndefined();
    const confirmed = await runner.withDataContext(owner, (scope) =>
      actions.resolveAssistantAction(scope, future.id, { status: "confirmed" })
    );
    expect(confirmed?.status).toBe("confirmed");
    expect(
      await runner.withDataContext(owner, (scope) =>
        actions.expireAssistantAction(scope, future.id)
      )
    ).toBeUndefined();
    const overdue = await createAction(thread.id, new Date(Date.now() - 1000));
    expect(
      await runner.withDataContext(owner, (scope) =>
        actions.resolveAssistantAction(scope, overdue.id, { status: "confirmed" })
      )
    ).toBeUndefined();
    expect(
      (
        await runner.withDataContext(owner, (scope) =>
          actions.expireAssistantAction(scope, overdue.id)
        )
      )?.status
    ).toBe("timed_out");
    expect(
      await runner.withDataContext(owner, (scope) =>
        actions.expireAssistantAction(scope, overdue.id)
      )
    ).toBeUndefined();
    expect(
      await runner.withDataContext(owner, (scope) =>
        actions.resolveAssistantAction(scope, overdue.id, { status: "rejected" })
      )
    ).toBeUndefined();
  });

  it("keeps origins immutable and expiration owner-scoped, including administrators", async () => {
    const thread = await runner.withDataContext(owner, (scope) =>
      chat.openNewThread(scope, { title: "Owner origin" })
    );
    const request = await createAction(thread.id, new Date(Date.now() - 1000));
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      expect(
        await runner.withDataContext({ actorUserId }, (scope) =>
          actions.expireAssistantAction(scope, request.id)
        )
      ).toBeUndefined();
      expect(
        await runner.withDataContext({ actorUserId }, (scope) =>
          actions.getAssistantAction(scope, request.id)
        )
      ).toBeUndefined();
    }
    await expect(
      runner.withDataContext(owner, (scope) =>
        scope.db
          .updateTable("app.ai_assistant_action_requests")
          .set({ chat_thread_id: null })
          .where("id", "=", request.id)
          .execute()
      )
    ).rejects.toThrow("origin cannot be changed");
    expect(
      (
        await runner.withDataContext(owner, (scope) =>
          actions.getAssistantAction(scope, request.id)
        )
      )?.status
    ).toBe("pending");
  });
});
