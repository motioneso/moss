import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AiRepository } from "@moss/ai";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { DEFAULT_CHAT_SURFACE, type ChatActivityEventDto } from "@moss/shared";
import type { TerminalActionRecord } from "../../packages/chat/src/action-record-history.js";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { DataContextChatPersistence } from "../../packages/chat/src/live/persistence.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const owner = { actorUserId: ids.userA };
const executed = { provider: "anthropic", model: "offline-fixture" } as const;
const pending: TranscriptRecord = {
  kind: "action_request",
  actionRequestId: "origin-action-a",
  toolName: "tasks.create",
  text: "Create the task",
  summary: "Create the task"
};
const timeout: TerminalActionRecord = {
  kind: "action_result",
  actionRequestId: "origin-action-a",
  toolName: "tasks.create",
  text: "denied",
  summary: "Create the task",
  outcome: "denied",
  decidedBy: "timeout",
  reason: "Action timed out.",
  durationMs: 30_000
};

let app: Kysely<MossDatabase>;
let observer: Kysely<MossDatabase>;
let runner: DataContextRunner;
const repository = new ChatRepository();

beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  // Observe lock waits only; all chat reads and writes use the runtime role and DataContext.
  observer = createDatabase({ connectionString: connectionStrings.bootstrap });
  runner = new DataContextRunner(app);
});

afterAll(async () => {
  await Promise.all([app?.destroy(), observer?.destroy()]);
});

function persistence(): DataContextChatPersistence {
  return new DataContextChatPersistence({
    dataContext: runner,
    chatRepository: new ChatRepository(),
    aiRepository: new AiRepository()
  });
}

function manager(
  store = persistence(),
  engineOverrides: Partial<CliChatEngine> = {}
): ChatSessionManager {
  // Provider/engine execution is outside this persistence regression; the database port is real.
  vi.spyOn(store, "resolveActiveProvider").mockResolvedValue({
    ...executed,
    providerConfigId: "offline-provider",
    authMethod: "cli",
    acpAgentId: "claude"
  });
  const engine: CliChatEngine = {
    provider: executed.provider,
    async launch() {
      return { offset: 0 };
    },
    async submit() {},
    async interrupt() {},
    async readNew() {
      return { records: [], offset: 0, complete: true };
    },
    async isAlive() {
      return true;
    },
    async kill() {},
    ...engineOverrides
  };
  return new ChatSessionManager({
    persistence: store,
    engineFactory: () => engine,
    personaFs: { async mkdir() {}, async writeFile() {} },
    clock: { now: () => 1_725_000_000_000 },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "Origin action history fixture",
    serverOwnsDrain: true
  });
}

function createThread(title: string, incognito = false) {
  return runner.withDataContext(owner, (db) => repository.openNewThread(db, { title, incognito }));
}

function reload(threadId: string, actorUserId: string = ids.userA) {
  return runner.withDataContext({ actorUserId }, (db) =>
    new ChatRepository().listMessages(db, threadId)
  );
}

function matchingResults(activity: readonly ChatActivityEventDto[]) {
  return activity.filter(
    (record) =>
      record.kind === "action_result" && record.actionRequestId === timeout.actionRequestId
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("origin-bound action history with the real database", () => {
  it("after restart a late A timeout updates only A while B stays selected and live", async () => {
    const a = await createThread("Origin A");
    const beforeRestart = manager();
    expect((await beforeRestart.ensureSession(ids.userA, "Owner")).threadId).toBe(a.id);
    await persistence().recordTurn(ids.userA, "A question", "A answer", executed, {
      threadId: a.id,
      activityRecords: [pending]
    });
    await beforeRestart.clear(ids.userA);
    const b = await persistence().getCurrentThreadState(ids.userA);
    expect(b?.id).not.toBe(a.id);
    expect(b).toBeDefined();
    await persistence().recordTurn(ids.userA, "B question", "B answer", executed, {
      threadId: b!.id
    });
    const beforeB = await reload(b!.id);
    const beforeA = await reload(a.id);
    const threadBefore = await runner.withDataContext(owner, (db) =>
      repository.getOwnedThreadById(db, ids.userA, a.id)
    );

    // No session/sequence/pending-result state is carried across this API restart.
    const restarted = manager();
    await restarted.resumeThread(ids.userA, b!.id);
    const seen: TranscriptRecord[] = [];
    const unsubscribe = restarted.subscribe(ids.userA, (record) => seen.push(record));
    try {
      expect((await restarted.ensureSession(ids.userA, "Owner")).threadId).toBe(b!.id);
      expect(await restarted.injectOriginRecord(ids.userA, a.id, timeout)).toEqual({
        historyPersisted: true
      });
      const afterFirst = await reload(a.id);
      expect(await restarted.injectOriginRecord(ids.userA, a.id, timeout)).toEqual({
        historyPersisted: true
      });
      expect(await reload(a.id)).toEqual(afterFirst);

      expect(seen).toEqual([]);
      expect(await persistence().getCurrentThreadState(ids.userA)).toEqual(b);
      expect((await restarted.ensureSession(ids.userA, "Owner")).threadId).toBe(b!.id);
      expect(await reload(b!.id)).toEqual(beforeB);
      const reloadedA = await reload(a.id);
      expect(reloadedA.map((message) => message.id)).toEqual(beforeA.map((message) => message.id));
      expect(reloadedA.map((message) => message.body)).toEqual(["A question", "A answer"]);
      const assistant = serializeMessage(reloadedA[1]!);
      expect(assistant.activity).toEqual([pending, timeout]);
      expect(matchingResults(assistant.activity)).toEqual([timeout]);
      expect(reloadedA[1]?.tool_metadata.actionResults).toEqual([timeout]);
      expect(reloadedA[1]?.tool_metadata.actionOutcomeOnly).toBeUndefined();
      expect(
        await runner.withDataContext(owner, (db) =>
          repository.getOwnedThreadById(db, ids.userA, a.id)
        )
      ).toEqual(threadBefore);
    } finally {
      unsubscribe();
      await restarted.dropSessionsForProvider(executed.provider);
    }
  });

  it("delivers a successful action's refresh hints after a drawer subscriber reconnects to the same origin", async () => {
    const origin = await createThread("Interrupted drawer action");
    const submitted = deferred<void>();
    const finish = deferred<void>();
    const store = persistence();
    const runtime = manager(store, {
      async submit() {
        submitted.resolve();
      },
      async readNew() {
        await finish.promise;
        return { records: [{ kind: "reply", text: "Theme changed." }], offset: 1, complete: true };
      }
    });
    await runtime.resumeThread(ids.userA, origin.id);
    const beforeClose: TranscriptRecord[] = [];
    const close = runtime.subscribe(ids.userA, (record) => beforeClose.push(record));
    const turn = runtime.submitTurn(ids.userA, "Owner", "Change the named theme");
    await submitted.promise;
    close();
    const reopened: TranscriptRecord[] = [];
    const unsubscribe = runtime.subscribe(ids.userA, (record) => reopened.push(record));
    const completed: TranscriptRecord = {
      kind: "action_result",
      text: "Executed: app.callAction",
      actionRequestId: "theme-action",
      toolName: "app.callAction",
      summary: "Switch your theme",
      outcome: "executed",
      decidedBy: "person",
      affectsQueryKeys: ["settings.themes"],
      affectsModules: ["settings"]
    };
    try {
      expect(await runtime.injectOriginRecord(ids.userA, origin.id, completed)).toEqual({
        historyPersisted: true
      });
      finish.resolve();
      await turn;
      expect(beforeClose.some((record) => record.kind === "action_result")).toBe(false);
      expect(reopened.filter((record) => record.kind === "action_result")).toEqual([completed]);
      expect(await store.getCurrentThreadState(ids.userA)).toEqual({
        id: origin.id,
        incognito: false
      });
      const history = (await reload(origin.id)).map(serializeMessage);
      expect(history.map((message) => message.body)).toEqual([
        "Change the named theme",
        "Theme changed."
      ]);
      expect(history[1]?.activity).toContainEqual(
        expect.objectContaining({
          kind: "action_result",
          actionRequestId: "theme-action",
          outcome: "executed"
        })
      );
    } finally {
      finish.resolve();
      await turn;
      unsubscribe();
      await runtime.dropSessionsForProvider(executed.provider);
    }
  });

  it.each([ids.userB, ids.adminUser])(
    "foreign actor %s cannot insert into the origin",
    async (actorUserId) => {
      const origin = await createThread("Owner-only origin");
      const store = persistence();
      const seen: TranscriptRecord[] = [];
      const foreignManager = manager(store);
      const unsubscribe = foreignManager.subscribe(actorUserId, (record) => seen.push(record));
      try {
        expect(await store.getOwnedThreadState(actorUserId, origin.id)).toBeUndefined();
        expect(await foreignManager.injectOriginRecord(actorUserId, origin.id, timeout)).toEqual({
          historyPersisted: false,
          historyIgnored: true
        });
        expect(await store.persistActionRecord(actorUserId, origin.id, timeout)).toBe(false);
        // Supplying the real owner's ID must not override the runtime transaction's RLS actor.
        expect(
          await runner.withDataContext({ actorUserId }, (db) =>
            repository.persistActionRecord(db, ids.userA, origin.id, timeout)
          )
        ).toBe(false);
        expect(seen).toEqual([]);
        expect(await reload(origin.id, actorUserId)).toEqual([]);
        expect(await reload(origin.id)).toEqual([]);
      } finally {
        unsubscribe();
      }
    }
  );

  it("recovers a timed-out origin silently and preserves its previously stored title and duration", async () => {
    const origin = await createThread("Recovery origin");
    const store = persistence();
    expect(await store.persistActionRecord(ids.userA, origin.id, timeout)).toBe(true);
    const before = await reload(origin.id);
    const restarted = manager();
    const seen: TranscriptRecord[] = [];
    const unsubscribe = restarted.subscribe(ids.userA, (record) => seen.push(record));
    try {
      expect(
        await restarted.injectOriginRecord(
          ids.userA,
          origin.id,
          {
            kind: "action_result",
            text: "",
            actionRequestId: timeout.actionRequestId,
            outcome: "denied",
            decidedBy: "timeout"
          },
          undefined,
          true
        )
      ).toEqual({ historyPersisted: true });
      expect(seen).toEqual([]);
      expect(await reload(origin.id)).toEqual(before);
    } finally {
      unsubscribe();
    }
  });

  it("delivers an incognito terminal record live without saving any history", async () => {
    const origin = await createThread("Private origin", true);
    const store = persistence();
    expect(await store.getOwnedThreadState(ids.userA, origin.id)).toEqual({
      id: origin.id,
      surface: DEFAULT_CHAT_SURFACE,
      incognito: true
    });
    const privateManager = manager(store);
    const seen: TranscriptRecord[] = [];
    const unsubscribe = privateManager.subscribe(ids.userA, (record) => seen.push(record));
    try {
      expect(await privateManager.injectOriginRecord(ids.userA, origin.id, pending)).toEqual({
        historyPersisted: false,
        historyIgnored: true
      });
      expect(await privateManager.injectOriginRecord(ids.userA, origin.id, timeout)).toEqual({
        historyPersisted: false,
        historyIgnored: true
      });
      expect(matchingResults(seen)).toHaveLength(1);
      expect(await store.persistActionRecord(ids.userA, origin.id, timeout)).toBe(false);
      expect(
        await store.recordTurn(ids.userA, "private question", "private answer", executed, {
          threadId: origin.id,
          activityRecords: [pending, timeout]
        })
      ).toBeUndefined();
      expect(await reload(origin.id)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it("absorbs an idempotent action-only result when the originating turn completes later", async () => {
    const origin = await createThread("Unfinished origin");
    const store = persistence();
    expect(await manager(store).injectOriginRecord(ids.userA, origin.id, timeout)).toEqual({
      historyPersisted: true
    });
    expect(await manager().injectOriginRecord(ids.userA, origin.id, timeout)).toEqual({
      historyPersisted: true
    });
    const orphan = await reload(origin.id);
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({ role: "assistant", body: "" });
    expect(orphan[0]?.tool_metadata).toMatchObject({
      actionOutcomeOnly: true,
      activity: [timeout],
      actionResults: [timeout]
    });
    expect(serializeMessage(orphan[0]!).activity).toEqual([timeout]);

    await store.recordTurn(ids.userA, "origin question", "origin answer", executed, {
      threadId: origin.id,
      activityRecords: [pending]
    });
    await manager().injectOriginRecord(ids.userA, origin.id, timeout);
    const completed = await reload(origin.id);
    expect(completed.map((message) => message.body)).toEqual(["origin question", "origin answer"]);
    expect(completed.some((message) => message.id === orphan[0]!.id)).toBe(false);
    expect(completed.some((message) => message.tool_metadata.actionOutcomeOnly)).toBe(false);
    expect(serializeMessage(completed[1]!).activity).toEqual([pending, timeout]);
    expect(completed[1]?.tool_metadata.actionResults).toEqual([timeout]);
    const retained = await runner.withDataContext(owner, (db) =>
      db.db
        .selectFrom("app.chat_messages")
        .selectAll()
        .where("id", "=", orphan[0]!.id)
        .executeTakeFirstOrThrow()
    );
    expect(retained).toEqual({
      ...orphan[0],
      tool_metadata: { ...orphan[0]!.tool_metadata, actionOutcomeHidden: true },
      updated_at: expect.any(Date)
    });
    expect(
      await runner.withDataContext(owner, (db) => repository.getMessageById(db, retained.id))
    ).toBeUndefined();
    const replay = await store.listPriorTurns(ids.userA, { threadId: origin.id });
    expect(replay.recent).toEqual([
      { role: "user", content: "origin question" },
      { role: "assistant", content: "origin answer" }
    ]);
    const threads = await runner.withDataContext(owner, (db) => repository.listThreads(db));
    expect(threads.find((thread) => thread.id === origin.id)?.lastMessageBody).toBe(
      "origin answer"
    );
    const archived = await runner.withDataContext(owner, (db) =>
      repository.listStoredMessagesInRange(
        db,
        ids.userA,
        "2000-01-01T00:00:00Z",
        "2100-01-01T00:00:00Z"
      )
    );
    expect(
      archived.filter((message) => message.threadId === origin.id).map((message) => message.body)
    ).toEqual(["origin question", "origin answer"]);
  });

  it("keeps a duplicate from a later turn on the original ordinary assistant message", async () => {
    const origin = await createThread("Same-conversation duplicate");
    const store = persistence();
    const original = await store.recordTurn(ids.userA, "first question", "first answer", executed, {
      threadId: origin.id,
      activityRecords: [pending]
    });
    expect(await store.persistActionRecord(ids.userA, origin.id, timeout)).toBe(true);
    await store.recordTurn(ids.userA, "later question", "later answer", executed, {
      threadId: origin.id,
      activityRecords: [pending, timeout],
      actionResults: [timeout]
    });
    expect(await store.persistActionRecord(ids.userA, origin.id, timeout)).toBe(true);

    const history = (await reload(origin.id)).map(serializeMessage);
    expect(history.map((message) => message.body)).toEqual([
      "first question",
      "first answer",
      "later question",
      "later answer"
    ]);
    expect(history[1]?.id).toBe(original?.assistantMessageId);
    expect(history[1]?.activity).toEqual([pending, timeout]);
    expect(history[3]?.activity).toEqual([]);
    expect(history.flatMap((message) => matchingResults(message.activity))).toEqual([timeout]);
    const latest = (await reload(origin.id))[3]!;
    expect(latest.tool_metadata.actionResults ?? []).toEqual([]);
  });

  it.each(["outcome", "completion"] as const)(
    "serializes concurrent writes when %s holds the origin history lock first",
    async (first) => {
      const origin = await createThread(`Concurrent ${first}`);
      const store = persistence();
      const locked = deferred<number>();
      const release = deferred<void>();
      const firstWrite = runner.withDataContext(owner, async (db) => {
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db.db);
        if (first === "outcome") {
          await repository.persistActionRecord(db, ids.userA, origin.id, timeout);
        } else {
          await repository.recordCompletedTurn(
            db,
            origin.id,
            "racing question",
            "racing answer",
            executed,
            {
              activityRecords: [pending]
            }
          );
        }
        locked.resolve(pid.rows[0]!.pid);
        await release.promise;
      });
      const blockerPid = await Promise.race([
        locked.promise,
        firstWrite.then(() => {
          throw new Error("First write ended without holding its lock");
        })
      ]);
      const secondWrite =
        first === "outcome"
          ? store.recordTurn(ids.userA, "racing question", "racing answer", executed, {
              threadId: origin.id,
              activityRecords: [pending]
            })
          : store.persistActionRecord(ids.userA, origin.id, timeout);
      try {
        await vi.waitFor(
          async () => {
            const waiting = await sql<{ blocked: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE ${blockerPid} = ANY(pg_blocking_pids(pid))
          ) AS blocked`.execute(observer);
            expect(waiting.rows).toEqual([{ blocked: true }]);
          },
          { timeout: 5_000 }
        );
      } finally {
        release.resolve();
        await Promise.all([firstWrite, secondWrite]);
      }

      const saved = await reload(origin.id);
      expect(saved.map((message) => message.body)).toEqual(["racing question", "racing answer"]);
      expect(saved.some((message) => message.tool_metadata.actionOutcomeOnly)).toBe(false);
      expect(serializeMessage(saved[1]!).activity).toEqual([pending, timeout]);
      expect(saved[1]?.tool_metadata.actionResults).toEqual([timeout]);
    }
  );
});
