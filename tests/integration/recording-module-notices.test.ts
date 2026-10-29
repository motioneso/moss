import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { ManagedSourceFencedError, ManagedSourceUnavailableError } from "@moss/notes";
import type { ModuleNoticeSource } from "@moss/shared";
import {
  ModuleNoticeService,
  type ModuleNoticeDefinition
} from "../../packages/chat/src/module-notices.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { serializeMessage } from "../../packages/chat/src/route-serializers.js";
import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { ids, connectionStrings } from "./test-database.js";
import { createDatabase, getOwnedPgClientConstructor, type OwnedPgClient } from "@moss/db";
import { startStoredMessageArrivalListener } from "../../packages/chat/src/stored-message-arrival.js";
import { MODULE_NOTICE_ARRIVAL_CHANNEL } from "../../packages/chat/src/module-notices.js";
import type { BackgroundMessage } from "../../packages/chat/src/live/background-message-routing.js";

const fixture = useRecordingMemoryFixture();
const chat = new ChatRepository();

async function setup(role: "app" | "worker" = "app") {
  const state = await fixture.setup(role);
  const recording = await state.create();
  const source: ModuleNoticeSource = {
    moduleId: "meetings",
    sourceId: recording.sourceId,
    sourceVersion: "1",
    noticeKind: "side_uncertainty"
  };
  const key = {
    ownerUserId: state.owner.actorUserId,
    sourceModuleId: "meetings",
    sourceId: source.sourceId
  };
  await state.lifecycle.registerSource(state.owner, key);
  const definition: ModuleNoticeDefinition = {
    moduleId: "meetings",
    noticeKind: "side_uncertainty",
    actionNames: ["meetings.correct_side"],
    async withCurrentSource(access, request, work) {
      try {
        return await state.runner.withDataContext(access, async (db) => {
          const snapshot = await state.lifecycle.captureSourcesScoped(db, [
            { ...key, sourceId: request.sourceId, ownerUserId: access.actorUserId }
          ]);
          return state.lifecycle.withPublicationScoped(db, snapshot, async (scoped) => {
            const metadata = await fixture.metadata.get(scoped, request.sourceId);
            if (!metadata || String(metadata.outputVersion) !== request.sourceVersion)
              return undefined;
            return work(scoped, {
              text: `Filed this recording as ${metadata.side}. Review the recording to change it.`,
              actions: [
                {
                  toolName: "meetings.correct_side",
                  label: "Change side",
                  sourceId: request.sourceId,
                  sourceVersion: request.sourceVersion
                }
              ]
            });
          });
        });
      } catch (error) {
        if (
          error instanceof ManagedSourceUnavailableError ||
          error instanceof ManagedSourceFencedError
        )
          return undefined;
        throw error;
      }
    }
  };
  const service = new ModuleNoticeService(state.runner, [definition]);
  const main = await fixture.fixtures.withDataContext(state.owner, (db) =>
    chat.ensureMainThread(db, state.owner.actorUserId)
  );
  return { state, source, service, main, definition, key };
}

for (const role of ["app", "worker"] as const)
  describe(`${role} Main notice admission`, () => {
    it("persists one durable assistant message across concurrent replay and reads the same history origin", async () => {
      const { state, source, service, main } = await setup(role);
      const results = await Promise.all([
        service.publish(state.owner, source),
        service.publish(state.owner, source)
      ]);
      expect(results.map((x) => x.state).sort()).toEqual(["duplicate", "stored"]);
      const saved = results.find((x) => x.state === "stored")!;
      if (saved.state !== "stored") throw new Error("Expected stored notice");
      await fixture.fixtures.withDataContext(state.owner, async (db) => {
        const notice = await sql<{
          n: number;
        }>`select count(*)::int n from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
          db.db
        );
        expect(notice.rows[0]?.n).toBe(1);
        const message = await chat.getMessageById(db, saved.messageId);
        expect(message?.thread_id).toBe(main.id);
        expect(serializeMessage(message!).origin).toMatchObject({
          kind: "module_notice",
          moduleId: "meetings",
          sourceId: source.sourceId,
          sourceVersion: "1"
        });
      });
      const live = await service.readArrival(state.owner, {
        actorUserId: state.owner.actorUserId,
        threadId: saved.threadId,
        messageId: saved.messageId
      });
      expect(live?.record.text).toContain("work");
      expect(live?.record.origin).toMatchObject({
        kind: "module_notice",
        noticeId: saved.noticeId
      });
    });

    it("rejects a stale version and a deletion fence without writing a message", async () => {
      const { state, source, service, key } = await setup(role);
      await expect(
        service.publish(state.owner, { ...source, sourceVersion: "2" })
      ).resolves.toEqual({ state: "stale" });
      await state.lifecycle.fenceSource(state.owner, key);
      await expect(service.publish(state.owner, source)).resolves.toEqual({ state: "stale" });
      const rows = await fixture.fixtures.withDataContext(state.owner, (db) =>
        sql`select id from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
          db.db
        )
      );
      expect(rows.rows).toEqual([]);
    });

    it("does not admit a different owner, including an administrator", async () => {
      const { state, source, service } = await setup(role);
      expect((await service.publish(state.owner, source)).state).toBe("stored");
      for (const actorUserId of [ids.userB, ids.adminUser]) {
        await expect(service.publish({ actorUserId }, source)).resolves.toEqual({ state: "stale" });
        const hidden = await state.runner.withDataContext({ actorUserId }, (db) =>
          sql`select id from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
            db.db
          )
        );
        expect(hidden.rows).toEqual([]);
      }
    });
  });

it("returns no_main without selecting an unrelated conversation or storing half a receipt", async () => {
  const state = await fixture.setup("app", ids.userD);
  const recording = await state.create();
  const source: ModuleNoticeSource = {
    moduleId: "meetings",
    sourceId: recording.sourceId,
    sourceVersion: "1",
    noticeKind: "side_uncertainty"
  };
  const service = new ModuleNoticeService(state.runner, [
    {
      moduleId: "meetings",
      noticeKind: "side_uncertainty",
      actionNames: [],
      withCurrentSource: (access, _source, work) =>
        state.runner.withDataContext(access, (db) =>
          work(db, { text: "Synthetic current source notice", actions: [] })
        )
    }
  ]);
  await expect(service.publish(state.owner, source)).resolves.toEqual({ state: "no_main" });
  await state.runner.withDataContext(state.owner, async (db) => {
    expect(await chat.getMainThread(db, ids.userD)).toBeUndefined();
    expect(
      (
        await sql`select id from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
          db.db
        )
      ).rows
    ).toEqual([]);
  });
});

it("recovers an exhausted no-Main delivery from durable intent without regenerating", async () => {
  const state = await fixture.setup("app", ids.userD);
  const recording = await state.create();
  const source: ModuleNoticeSource = {
    moduleId: "meetings",
    sourceId: recording.sourceId,
    sourceVersion: "1",
    noticeKind: "side_uncertainty"
  };
  const definition: ModuleNoticeDefinition = {
    moduleId: "meetings",
    noticeKind: "side_uncertainty",
    actionNames: [],
    withCurrentSource: (access, _source, work) =>
      state.runner.withDataContext(access, (db) =>
        work(db, { text: "Uncertain personal/work classification", actions: [] })
      )
  };
  const service = new ModuleNoticeService(state.runner, [definition]);
  // An arbitrary number of delivery attempts cannot consume the durable source intent.
  for (let attempt = 0; attempt < 10; attempt++)
    expect(await service.publish(state.owner, source)).toEqual({ state: "no_main" });
  const pending = await state.runner.withDataContext(state.owner, (db) =>
    sql`select source_id from app.chat_module_notice_intents where source_id=${source.sourceId}::uuid`.execute(
      db.db
    )
  );
  expect(pending.rows).toHaveLength(1);
  await state.runner.withDataContext(state.owner, (db) =>
    chat.ensureMainThread(db, state.owner.actorUserId)
  );
  await service.recoverPending(state.owner);
  await service.recoverPending(state.owner);
  await state.runner.withDataContext(state.owner, async (db) => {
    const rows =
      await sql`select message_id from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
        db.db
      );
    expect(rows.rows).toHaveLength(1);
    expect(
      (
        await sql`select source_id from app.chat_module_notice_intents where source_id=${source.sourceId}::uuid`.execute(
          db.db
        )
      ).rows
    ).toHaveLength(0);
  });
});

it("rejects wrong notification owner, thread, role, status, ledger identity and provenance", async () => {
  const { state, source, service } = await setup();
  const saved = await service.publish(state.owner, source);
  if (saved.state !== "stored") throw new Error("Expected stored notice");
  const arrival = {
    actorUserId: state.owner.actorUserId,
    threadId: saved.threadId,
    messageId: saved.messageId
  };
  await expect(
    service.readArrival({ actorUserId: ids.adminUser }, arrival)
  ).resolves.toBeUndefined();
  await expect(
    service.readArrival(state.owner, { ...arrival, actorUserId: ids.userB })
  ).resolves.toBeUndefined();
  await expect(
    service.readArrival(state.owner, { ...arrival, threadId: randomUUID() })
  ).resolves.toBeUndefined();
  const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  try {
    const original = await fixture.fixtures.withDataContext(state.owner, (db) =>
      chat.getMessageById(db, saved.messageId)
    );
    for (const [column, value] of [
      ["role", "user"],
      ["status", "error"]
    ] as const) {
      await bootstrap
        .updateTable("app.chat_messages")
        .set({ [column]: value })
        .where("id", "=", saved.messageId)
        .execute();
      await expect(service.readArrival(state.owner, arrival)).resolves.toBeUndefined();
      await bootstrap
        .updateTable("app.chat_messages")
        .set({ role: "assistant", status: "stored" })
        .where("id", "=", saved.messageId)
        .execute();
    }
    for (const origin of [
      { version: 1, kind: "reminder", event: "delivered", reminderId: randomUUID() },
      { ...serializeMessage(original!).origin, noticeId: randomUUID() },
      { ...serializeMessage(original!).origin, sourceVersion: "wrong" }
    ]) {
      await bootstrap
        .updateTable("app.chat_messages")
        .set({ model_metadata: { origin } })
        .where("id", "=", saved.messageId)
        .execute();
      await expect(service.readArrival(state.owner, arrival)).resolves.toBeUndefined();
    }
  } finally {
    await bootstrap.destroy();
  }
});

it("rolls receipt, message and notification back together when message persistence fails", async () => {
  const { state, source, definition } = await setup();
  class FailingChat extends ChatRepository {
    override async insertReservedAssistantMessage(): Promise<void> {
      throw new Error("Synthetic publication interruption");
    }
  }
  const service = new ModuleNoticeService(state.runner, [definition], new FailingChat());
  await expect(service.publish(state.owner, source)).rejects.toThrow(
    "Synthetic publication interruption"
  );
  await fixture.fixtures.withDataContext(state.owner, async (db) => {
    expect(
      (
        await sql`select id from app.chat_module_notices where source_id=${source.sourceId}::uuid`.execute(
          db.db
        )
      ).rows
    ).toEqual([]);
  });
});

it("keeps history but rejects live delivery when the owning source revision changes", async () => {
  const { state, source, service } = await setup();
  const saved = await service.publish(state.owner, source);
  if (saved.state !== "stored") throw new Error("Expected stored notice");
  await state.flip({ sourceId: source.sourceId }, 2);
  await expect(
    service.readArrival(state.owner, {
      actorUserId: state.owner.actorUserId,
      threadId: saved.threadId,
      messageId: saved.messageId
    })
  ).resolves.toBeUndefined();
  const message = await fixture.fixtures.withDataContext(state.owner, (db) =>
    chat.getMessageById(db, saved.messageId)
  );
  expect(serializeMessage(message!).origin).toMatchObject({
    kind: "module_notice",
    sourceVersion: "1"
  });
});

it("reconnects the real listener, carries IDs only and recovers missed deliveries from stored history", async () => {
  const { state, source, service, key } = await setup();
  const clients: OwnedPgClient[] = [];
  const messages: BackgroundMessage[] = [];
  const payloads: string[] = [];
  const running = startStoredMessageArrivalListener({
    connectionString: connectionStrings.app,
    channel: MODULE_NOTICE_ARRIVAL_CHANNEL,
    label: "module notice arrival",
    retryMs: 20,
    createClient(connectionString) {
      const client = new (getOwnedPgClientConstructor())({ connectionString });
      client.on("notification", (n) => {
        if (n.channel === MODULE_NOTICE_ARRIVAL_CHANNEL) payloads.push(n.payload ?? "");
      });
      clients.push(client);
      return client;
    },
    read: (arrival) => service.readArrival({ actorUserId: arrival.actorUserId }, arrival),
    deliver: async (message) => {
      messages.push(message);
    },
    warn: () => {}
  });
  const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  await running.ready;
  try {
    const saved = await service.publish(state.owner, source);
    if (saved.state !== "stored") throw new Error("Expected stored notice");
    await service.publish(state.owner, source);
    await vi.waitFor(() => expect(messages).toHaveLength(1));
    expect(JSON.parse(payloads[0]!)).toEqual({
      actorUserId: state.owner.actorUserId,
      threadId: saved.threadId,
      messageId: saved.messageId
    });
    const pid = (await clients[0]!.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0]!
      .pid;
    await sql`select pg_terminate_backend(${pid})`.execute(bootstrap);
    await vi.waitFor(async () => {
      expect(clients.length).toBeGreaterThanOrEqual(2);
      const channels = await clients[clients.length - 1]!.query<{ channel: string }>(
        "select pg_listening_channels() channel"
      );
      expect(channels.rows.map((row) => row.channel)).toContain(MODULE_NOTICE_ARRIVAL_CHANNEL);
    });
    const next = await state.create();
    await state.lifecycle.registerSource(state.owner, { ...key, sourceId: next.sourceId });
    const nextSaved = await service.publish(state.owner, { ...source, sourceId: next.sourceId });
    if (nextSaved.state !== "stored") throw new Error("Expected stored notice");
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[1]?.record.messageId).toBe(nextSaved.messageId);
  } finally {
    await running.stop();
    await bootstrap.destroy();
  }
  const offline = await state.create();
  await state.lifecycle.registerSource(state.owner, { ...key, sourceId: offline.sourceId });
  const missed = await service.publish(state.owner, { ...source, sourceId: offline.sourceId });
  if (missed.state !== "stored") throw new Error("Expected stored notice");
  const history = await fixture.fixtures.withDataContext(state.owner, (db) =>
    chat.getMessageById(db, missed.messageId)
  );
  expect(serializeMessage(history!).origin).toMatchObject({
    kind: "module_notice",
    noticeId: missed.noticeId
  });
  expect(messages).toHaveLength(2);
});

async function hostNoticeSetup(role: "app" | "worker") {
  const state = await fixture.setup(role);
  const recording = await state.create();
  async function confidence(value: number) {
    await fixture.fixtures.withDataContext(state.owner, async (db) => {
      await fixture.records.get(db, recording.sourceId, { forUpdate: true });
      const before = await fixture.metadata.get(db, recording.sourceId);
      if (!before) throw new Error("Expected source metadata");
      await fixture.metadata.apply(
        db,
        before,
        {
          typeId: before.typeId ?? "other",
          title: "Synthetic recording",
          side: "work",
          confidence: value,
          reason: "This may be a personal project.",
          ideaGroups: []
        },
        1
      );
    });
  }
  await confidence(0.6);
  const { createRecordingNoticeRuntime } =
    await import("../../packages/module-registry/src/recording-notice-runtime.js");
  const runtime = createRecordingNoticeRuntime({
    dataContext: state.runner,
    isMeetingsAvailable: async () => true
  });
  await fixture.fixtures.withDataContext(state.owner, (db) =>
    chat.ensureMainThread(db, state.owner.actorUserId)
  );
  return { state, recording, runtime, confidence, createRecordingNoticeRuntime };
}

it("recovers production intent after the worker exhausts retries without Main", async () => {
  const { createPgBossClient } = await import("@moss/jobs");
  const { registerRecordingNoticeWorker, RECORDING_NOTICE_QUEUE, recordingSideReviewVersion } =
    await import("@moss/meetings");
  const { createRecordingNoticeRuntime } =
    await import("../../packages/module-registry/src/recording-notice-runtime.js");
  const state = await fixture.setup("app", ids.userC);
  const recording = await state.create();
  const sourceVersion = await state.runner.withDataContext(state.owner, async (db) => {
    const current = await fixture.metadata.get(db, recording.sourceId);
    await fixture.metadata.apply(
      db,
      current!,
      {
        typeId: "idea",
        title: "Uncertain source",
        side: "work",
        confidence: 0.6,
        reason: "It might be a hobby.",
        ideaGroups: []
      },
      1
    );
    return recordingSideReviewVersion((await fixture.metadata.get(db, recording.sourceId))!);
  });
  expect(sourceVersion).toBeTruthy();
  const runtime = createRecordingNoticeRuntime({
    dataContext: state.runner,
    isMeetingsAvailable: async () => true
  });
  const boss = createPgBossClient(connectionStrings.worker);
  const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  await boss.start();
  try {
    // Exhaust on the first real worker failure rather than waiting for the backoff budget.
    await boss.updateQueue(RECORDING_NOTICE_QUEUE, { retryLimit: 0 });
    await state.runner.withDataContext(state.owner, (db) =>
      runtime.enqueue(boss)(db, {
        actorUserId: state.owner.actorUserId,
        resourceId: recording.sourceId,
        sourceVersion: sourceVersion!,
        idempotencyKey: randomUUID()
      })
    );
    await registerRecordingNoticeWorker(boss, runtime.publishSideReview);
    await vi.waitFor(
      async () => {
        const job = await sql<{ state: string }>`select state from pgboss.job
        where name=${RECORDING_NOTICE_QUEUE} and data->>'resourceId'=${recording.sourceId}`.execute(
          bootstrap
        );
        expect(job.rows[0]?.state).toBe("failed");
      },
      { timeout: 15000, interval: 100 }
    );
    const { collectModuleNoticeExport } =
      await import("../../packages/chat/src/module-notice-export.js");
    const context = { ...state.owner, requestId: randomUUID() };
    const pending = await state.runner.withDataContext(state.owner, (db) =>
      collectModuleNoticeExport(db, context)
    );
    expect(pending).toContainEqual(
      expect.objectContaining({ sourceId: recording.sourceId, state: "pending" })
    );
    for (const actorUserId of [ids.userB, ids.adminUser])
      expect(
        await state.runner.withDataContext({ actorUserId }, (db) =>
          collectModuleNoticeExport(db, context)
        )
      ).toEqual([]);
    await fixture.fixtures.withDataContext(state.owner, (db) =>
      chat.ensureMainThread(db, state.owner.actorUserId)
    );
    await runtime.notices.recoverPending(state.owner);
    await runtime.notices.recoverPending(state.owner);
    const stored = await state.runner.withDataContext(state.owner, (db) =>
      collectModuleNoticeExport(db, context)
    );
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ sourceId: recording.sourceId, state: "stored" });
  } finally {
    await boss.updateQueue(RECORDING_NOTICE_QUEUE, { retryLimit: 8 });
    await boss.stop({ graceful: false });
    await bootstrap.destroy();
  }
});

it("discards superseded pending intent and retains intent while its module is unavailable", async () => {
  const { state, recording, runtime, confidence, createRecordingNoticeRuntime } =
    await hostNoticeSetup("app");
  const { recordingSideReviewVersion } = await import("@moss/meetings");
  const current = await state.runner.withDataContext(state.owner, (db) =>
    fixture.metadata.get(db, recording.sourceId)
  );
  const sourceVersion = recordingSideReviewVersion(current!);
  await state.runner.withDataContext(state.owner, (db) =>
    runtime.enqueue({ send: async () => randomUUID() })(db, {
      actorUserId: state.owner.actorUserId,
      resourceId: recording.sourceId,
      sourceVersion: sourceVersion!,
      idempotencyKey: randomUUID()
    })
  );
  const pending = () =>
    state.runner.withDataContext(state.owner, (db) =>
      sql`select source_id from app.chat_module_notice_intents where source_id=${recording.sourceId}::uuid`.execute(
        db.db
      )
    );
  const unavailable = createRecordingNoticeRuntime({
    dataContext: state.runner,
    isMeetingsAvailable: async () => false
  });
  await unavailable.notices.recoverPending(state.owner);
  expect((await pending()).rows).toHaveLength(1);
  await confidence(0.7);
  await runtime.notices.recoverPending(state.owner);
  expect((await pending()).rows).toHaveLength(0);
  const notices = await state.runner.withDataContext(state.owner, (db) =>
    sql`select id from app.chat_module_notices where source_id=${recording.sourceId}::uuid`.execute(
      db.db
    )
  );
  expect(notices.rows).toEqual([]);
});

for (const role of ["app", "worker"] as const)
  describe(`${role} production notice host`, () => {
    it("publishes code-authored uncertainty from current owning metadata once", async () => {
      const { state, recording, runtime } = await hostNoticeSetup(role);
      const result = await runtime.publishSideReview(state.owner, recording.sourceId);
      if (result.state !== "stored") throw new Error("Expected host notice");
      await expect(
        runtime.publishSideReview(state.owner, recording.sourceId)
      ).resolves.toMatchObject({ state: "duplicate", messageId: result.messageId });
      const live = await runtime.notices.readArrival(state.owner, {
        actorUserId: state.owner.actorUserId,
        threadId: result.threadId,
        messageId: result.messageId
      });
      expect(live?.record.text).toContain("as work");
      expect(live?.record.text).toContain("This may be a personal project.");
      expect(live?.record.origin).toMatchObject({
        kind: "module_notice",
        sourceId: recording.sourceId,
        sourceVersion: expect.stringMatching(/^1:[a-f0-9]{64}$/),
        actions: []
      });
      await expect(
        runtime.publishSideReview({ actorUserId: ids.adminUser }, recording.sourceId)
      ).resolves.toEqual({ state: "stale" });
    });

    it("declines a revised source, disabled module, and source deletion fence", async () => {
      const { state, recording, runtime, confidence, createRecordingNoticeRuntime } =
        await hostNoticeSetup(role);
      const saved = await runtime.publishSideReview(state.owner, recording.sourceId);
      if (saved.state !== "stored") throw new Error("Expected host notice");
      await confidence(0.7);
      await expect(
        runtime.notices.readArrival(state.owner, {
          actorUserId: state.owner.actorUserId,
          threadId: saved.threadId,
          messageId: saved.messageId
        })
      ).resolves.toBeUndefined();
      const disabled = createRecordingNoticeRuntime({
        dataContext: state.runner,
        isMeetingsAvailable: async () => false
      });
      await expect(disabled.publishSideReview(state.owner, recording.sourceId)).resolves.toEqual({
        state: "stale"
      });
      await state.lifecycle.fenceSource(state.owner, {
        ownerUserId: state.owner.actorUserId,
        sourceModuleId: "meetings",
        sourceId: recording.sourceId
      });
      await expect(runtime.publishSideReview(state.owner, recording.sourceId)).resolves.toEqual({
        state: "stale"
      });
    });
  });

it("does not publish a side notice for a confident current classification", async () => {
  const { state, recording, runtime, confidence } = await hostNoticeSetup("app");
  await confidence(1);
  await expect(runtime.publishSideReview(state.owner, recording.sourceId)).resolves.toEqual({
    state: "not_applicable"
  });
  const notices = await fixture.fixtures.withDataContext(state.owner, (db) =>
    sql`select id from app.chat_module_notices where source_id=${recording.sourceId}::uuid`.execute(
      db.db
    )
  );
  expect(notices.rows).toEqual([]);
});

it("runs the registered API notice listener lifecycle with the production host adapter", async () => {
  const { state, recording, runtime } = await hostNoticeSetup("worker");
  const { default: Fastify } = await import("fastify");
  const { registerModuleNoticeArrivalLifecycle } = await import("@moss/chat");
  const received: BackgroundMessage[] = [];
  const server = Fastify();
  registerModuleNoticeArrivalLifecycle(server, {
    connectionString: connectionStrings.app,
    notices: runtime.notices,
    manager: {
      deliverBackgroundMessage: async (message) => {
        received.push(message);
      }
    }
  });
  try {
    await server.ready();
    const saved = await runtime.publishSideReview(state.owner, recording.sourceId);
    if (saved.state !== "stored") throw new Error("Expected host notice");
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      actorUserId: state.owner.actorUserId,
      threadId: saved.threadId,
      record: {
        messageId: saved.messageId,
        background: true,
        origin: { kind: "module_notice", sourceId: recording.sourceId }
      }
    });
  } finally {
    await server.close();
  }
});

for (const role of ["app", "worker"] as const)
  describe(`${role} durable recording notice producer`, () => {
    async function manualRecording() {
      const { ManualEntryService } = await import("@moss/meetings");
      const state = await fixture.setup(role);
      const jobs: { resourceId: string; idempotencyKey: string }[] = [];
      const entry = new ManualEntryService(async (_db, payload) => {
        jobs.push(payload);
      });
      const record = await fixture.fixtures.withDataContext(state.owner, (db) =>
        entry.create(db, state.owner, {
          requestKey: randomUUID(),
          transcript: "Thinking aloud about a project that might be a work project or a hobby."
        })
      );
      const content = {
        overview: "A project is being considered.",
        decisions: [],
        actions: [],
        openQuestions: [],
        warnings: [],
        recording: {
          title: "A new project",
          typeId: "idea",
          side: "work",
          confidence: 0.6,
          reason: "This may be a hobby or a work project.",
          ideaGroups: []
        }
      };
      return { state, record, job: jobs[0]!, content };
    }
    it("commits only metadata intent with output, executes the owning worker, and replays without another notice", async () => {
      const { MeetingOutputService, registerRecordingNoticeWorker, RECORDING_NOTICE_QUEUE } =
        await import("@moss/meetings");
      const { createPgBossClient } = await import("@moss/jobs");
      const { createRecordingNoticeRuntime } =
        await import("../../packages/module-registry/src/recording-notice-runtime.js");
      const { state, record, job, content } = await manualRecording();
      await fixture.fixtures.withDataContext(state.owner, (db) =>
        chat.ensureMainThread(db, state.owner.actorUserId)
      );
      const boss = createPgBossClient(connectionStrings.worker);
      await boss.start();
      const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
      try {
        const runtime = createRecordingNoticeRuntime({
          dataContext: state.runner,
          isMeetingsAvailable: async () => true
        });
        const output = new MeetingOutputService(
          state.runner,
          async () => ({ content, modelRoute: "synthetic-notice-integration" }),
          undefined,
          undefined,
          runtime.enqueue(boss)
        );
        expect(
          await output.generateAutomatic(state.owner, job.resourceId, job.idempotencyKey)
        ).toMatchObject({ status: "saved", artifact: { stale: false } });
        const queued = await sql<{
          data: unknown;
        }>`select data from pgboss.job where name=${RECORDING_NOTICE_QUEUE} and data->>'resourceId'=${record.meetingId}`.execute(
          bootstrap
        );
        expect(queued.rows).toEqual([
          {
            data: {
              actorUserId: state.owner.actorUserId,
              resourceId: record.meetingId,
              sourceVersion: expect.stringMatching(/^1:[a-f0-9]{64}$/),
              idempotencyKey: job.idempotencyKey
            }
          }
        ]);
        await state.runner.withDataContext(state.owner, async (db) => {
          const pending = await sql`select source_id from app.chat_module_notice_intents
            where source_id=${record.meetingId}::uuid`.execute(db.db);
          expect(pending.rows).toHaveLength(1);
        });
        await fixture.fixtures.withDataContext(state.owner, async (db) => {
          expect(
            await fixture.records.putTitle(db, {
              meetingId: record.meetingId,
              expectedTitle: "A new project",
              title: "Owner's chosen title"
            })
          ).toMatchObject({ status: "saved" });
          const current = await fixture.metadata.get(db, record.meetingId);
          await fixture.metadata.putType(db, record.meetingId, current!.revision, "conversation");
        });
        await registerRecordingNoticeWorker(boss, runtime.publishSideReview);
        await vi.waitFor(
          async () => {
            const rows = await fixture.fixtures.withDataContext(state.owner, (db) =>
              sql`select id from app.chat_module_notices where source_id=${record.meetingId}::uuid`.execute(
                db.db
              )
            );
            expect(rows.rows).toHaveLength(1);
          },
          { timeout: 15000, interval: 100 }
        );
        expect(
          await output.generateAutomatic(state.owner, job.resourceId, job.idempotencyKey)
        ).toMatchObject({ status: "saved", replayed: true });
        const notices = await fixture.fixtures.withDataContext(state.owner, (db) =>
          sql`select id from app.chat_module_notices where source_id=${record.meetingId}::uuid`.execute(
            db.db
          )
        );
        expect(notices.rows).toHaveLength(1);
        expect(
          (
            await sql`select id from pgboss.job where name=${RECORDING_NOTICE_QUEUE} and data->>'resourceId'=${record.meetingId}`.execute(
              bootstrap
            )
          ).rows
        ).toHaveLength(1);
      } finally {
        await boss.stop({ graceful: false });
        await bootstrap.destroy();
      }
    });

    it("rolls back output and classification when durable intent cannot be queued", async () => {
      const { MeetingOutputService, MeetingOutputsRepository } = await import("@moss/meetings");
      const { state, record, job, content } = await manualRecording();
      const service = new MeetingOutputService(
        state.runner,
        async () => ({ content, modelRoute: "synthetic-notice-integration" }),
        undefined,
        undefined,
        async () => {
          throw new Error("Queue unavailable");
        }
      );
      expect(
        await service.generateAutomatic(state.owner, job.resourceId, job.idempotencyKey)
      ).toMatchObject({ status: "failed" });
      await fixture.fixtures.withDataContext(state.owner, async (db) => {
        expect(await new MeetingOutputsRepository().head(db, record.meetingId)).toBeNull();
        expect(await fixture.metadata.get(db, record.meetingId)).toMatchObject({
          side: null,
          outputVersion: null,
          revision: 0
        });
      });
    });

    it("does not let an obsolete queued version announce a newer classification", async () => {
      const { state, recording, runtime } = await hostNoticeSetup(role);
      await expect(
        runtime.publishSideReview(state.owner, recording.sourceId, "1:1")
      ).resolves.toEqual({ state: "stale" });
      const rows = await fixture.fixtures.withDataContext(state.owner, (db) =>
        sql`select id from app.chat_module_notices where source_id=${recording.sourceId}::uuid`.execute(
          db.db
        )
      );
      expect(rows.rows).toEqual([]);
    });
  });

it("exports stored notice context only to its owner and cascades it with its conversation", async () => {
  const { state, recording, runtime } = await hostNoticeSetup("app");
  const saved = await runtime.publishSideReview(state.owner, recording.sourceId);
  if (saved.state !== "stored") throw new Error("Expected stored notice");
  const { collectModuleNoticeExport } =
    await import("../../packages/chat/src/module-notice-export.js");
  const context = { actorUserId: state.owner.actorUserId, requestId: randomUUID() };
  const exported = await state.runner.withDataContext(state.owner, (db) =>
    collectModuleNoticeExport(db, context)
  );
  expect(exported).toContainEqual(
    expect.objectContaining({
      id: saved.noticeId,
      threadId: saved.threadId,
      messageId: saved.messageId,
      sourceId: recording.sourceId,
      sourceVersion: expect.stringMatching(/^1:[a-f0-9]{64}$/)
    })
  );
  for (const actorUserId of [ids.userB, ids.adminUser]) {
    const hidden = await state.runner.withDataContext({ actorUserId }, (db) =>
      collectModuleNoticeExport(db, context)
    );
    expect(hidden).toEqual([]);
  }
  const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  try {
    await bootstrap.deleteFrom("app.chat_threads").where("id", "=", saved.threadId).execute();
    expect(
      (
        await sql`select id from app.chat_module_notices where id=${saved.noticeId}::uuid`.execute(
          bootstrap
        )
      ).rows
    ).toEqual([]);
    expect(
      await fixture.fixtures.withDataContext(state.owner, (db) =>
        chat.getMessageById(db, saved.messageId)
      )
    ).toBeUndefined();
  } finally {
    await bootstrap.destroy();
  }
});
