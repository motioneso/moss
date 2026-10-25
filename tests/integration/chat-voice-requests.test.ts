import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { createVoiceRequestWorkerRuntime } from "@moss/module-registry";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { exportUserData } from "../../packages/settings/src/data-export.js";
import {
  ChatRepository,
  VoiceRequestRepository,
  VoiceRequestService,
  VoiceRequestConflictError,
  collectVoiceRequestExport,
  createVoiceRequestScheduler,
  CHAT_VOICE_REQUEST_QUEUE,
  type VoiceRequestDependencies,
  type VoiceRequestInput
} from "@moss/chat";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const actor = { actorUserId: ids.userA },
  other = { actorUserId: ids.userB };
const chat = new ChatRepository(),
  requests = new VoiceRequestRepository();
const now = new Date("2026-10-20T20:00:00.000Z");
let db: Kysely<MossDatabase>, root: Kysely<MossDatabase>, context: DataContextRunner;
let boss: PgBoss;
beforeAll(async () => {
  await resetFoundationDatabase();
  db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  root = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(db);
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  if (process.env.VOCCI_VOICE_RLS_NEGATIVE_CONTROL === "1")
    await sql`ALTER TABLE app.chat_voice_requests DISABLE ROW LEVEL SECURITY`.execute(root);
});
afterAll(async () => {
  await boss?.stop({ graceful: true });
  await Promise.allSettled([db?.destroy(), root?.destroy()]);
});
function input(overrides: Partial<VoiceRequestInput> = {}): VoiceRequestInput {
  return {
    version: 2,
    intent: "voice-request",
    sourceDeviceId: "test-ring",
    recordingId: randomUUID(),
    sourceFingerprint: "a".repeat(64),
    transcriptRevision: 1,
    transcript: "What is on my calendar?",
    capturedAt: now.toISOString(),
    automatic: true,
    ...overrides
  };
}
function setup(overrides: Partial<VoiceRequestDependencies> = {}) {
  const deps: VoiceRequestDependencies = {
    dataContext: context,
    bootId: randomUUID(),
    now: () => now,
    assertAvailable: async () => {},
    schedule: vi.fn(async () => {}),
    submit: vi.fn(async (_actor, request, claim) => {
      if (!(await claim())) return "unclaimed";
      await context.withDataContext(_actor, (ctx) =>
        chat.recordCompletedTurn(
          ctx,
          request.threadId,
          request.transcript,
          "Your calendar is clear.",
          { provider: "anthropic", model: "test" },
          { turnId: request.turnId }
        )
      );
      return "executed";
    }),
    ...overrides
  };
  return { service: new VoiceRequestService(deps), deps };
}

/** Pre-upgrade persisted row: default false policy, same canonical source fingerprint. */
async function legacy(value = input(), state: "ready-to-send" | "queued" = "ready-to-send") {
  return context.withDataContext(actor, async (ctx) => {
    const main = await chat.ensureMainThread(ctx, actor.actorUserId);
    return ctx.db
      .insertInto("app.chat_voice_requests")
      .values({
        id: randomUUID(),
        owner_user_id: actor.actorUserId,
        thread_id: main.id,
        source_device_id: value.sourceDeviceId,
        recording_id: value.recordingId,
        fingerprint: createHash("sha256").update(JSON.stringify(value)).digest("hex"),
        transcript_revision: value.transcriptRevision,
        transcript: value.transcript,
        captured_at: value.capturedAt ? new Date(value.capturedAt) : null,
        automatic: value.automatic,
        turn_id: randomUUID(),
        user_message_id: randomUUID(),
        assistant_message_id: randomUUID(),
        state,
        confirmed_at: null,
        dispatch_boot_id: null,
        dispatched_at: null,
        created_at: now,
        updated_at: now
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  });
}

describe("durable Main voice admission", () => {
  it("commits admission and metadata-only dispatch work with the receiver transaction", async () => {
    const { service } = setup({ schedule: createVoiceRequestScheduler(boss) });
    const value = input();
    let rolledBackId = "";
    await expect(
      context.withDataContext(actor, async (ctx) => {
        rolledBackId = (await service.admitInTransaction(ctx, value)).request.id;
        throw new Error("transcript commit failed");
      })
    ).rejects.toThrow("transcript commit failed");
    expect(await service.status(actor, rolledBackId)).toBeUndefined();
    const rolledBackJobs = await sql<{
      id: string;
    }>`SELECT id FROM pgboss.job WHERE name=${CHAT_VOICE_REQUEST_QUEUE} AND data->>'resourceId'=${rolledBackId}`.execute(
      root
    );
    expect(rolledBackJobs.rows).toHaveLength(0);
    const saved = await context.withDataContext(actor, (ctx) =>
      service.admitInTransaction(ctx, value)
    );
    const replay = await context.withDataContext(actor, (ctx) =>
      service.admitInTransaction(ctx, value)
    );
    expect(replay.request.id).toBe(saved.request.id);
    const jobs = await sql<{
      data: unknown;
    }>`SELECT data FROM pgboss.job WHERE name=${CHAT_VOICE_REQUEST_QUEUE} AND data->>'resourceId'=${saved.request.id}`.execute(
      root
    );
    expect(jobs.rows).toEqual([
      { data: { actorUserId: actor.actorUserId, resourceId: saved.request.id } }
    ]);
  });

  it("delivers a real queued job through the API-owned service and worker credentials", async () => {
    const { service, deps } = setup({ schedule: createVoiceRequestScheduler(boss) });
    let signal: () => void = () => {};
    const delivered = new Promise<void>((resolve) => {
      signal = resolve;
    });
    const original = deps.submit;
    let targetTurnId = "";
    deps.submit = async (...args) => {
      const result = await original(...args);
      if (args[1].turnId === targetTurnId) signal();
      return result;
    };
    const admitted = await service.admit(actor, input());
    targetTurnId = admitted.request.turn_id;
    const worker = createVoiceRequestWorkerRuntime(connectionStrings.worker, () => service);
    try {
      await worker.start();
      await delivered;
      expect((await service.status(actor, admitted.request.id))?.state).toBe("replied");
    } finally {
      await worker.close();
    }
  });

  it("lists only the current owner's retained requests", async () => {
    const { service } = setup();
    const admitted = await service.admit(actor, input({ automatic: false }));
    expect((await service.list(actor)).map((row) => row.id)).toContain(admitted.request.id);
    expect((await service.list(other)).map((row) => row.id)).not.toContain(admitted.request.id);
  });

  it("rolls admission back when durable work cannot be scheduled", async () => {
    const value = input();
    const failed = setup({
      schedule: async () => {
        throw new Error("queue unavailable");
      }
    });
    await expect(failed.service.admit(actor, value)).rejects.toThrow("queue unavailable");
    const found = await context.withDataContext(actor, (ctx) =>
      ctx.db
        .selectFrom("app.chat_voice_requests")
        .select("id")
        .where("recording_id", "=", value.recordingId)
        .execute()
    );
    expect(found).toHaveLength(0);
    expect((await setup().service.admit(actor, value)).created).toBe(true);
  });
  it("claims once across simultaneous deliveries and commits only the reserved pair", async () => {
    const { service } = setup();
    const { request } = await service.admit(actor, input());
    await Promise.all([service.process(actor, request.id), service.process(actor, request.id)]);
    expect((await service.status(actor, request.id))?.state).toBe("replied");
    const rows = await context.withDataContext(actor, (ctx) =>
      ctx.db
        .selectFrom("app.chat_messages")
        .select("id")
        .where(sql<boolean>`tool_metadata @> ${JSON.stringify({ turnId: request.turn_id })}::jsonb`)
        .execute()
    );
    expect(rows.map((row) => row.id).sort()).toEqual(
      [request.user_message_id, request.assistant_message_id].sort()
    );
  });
  it("reserves stable identities and replays admission without another job", async () => {
    const { service, deps } = setup(),
      value = input();
    const first = await service.admit(actor, value),
      replay = await service.admit(actor, value);
    expect(first.created).toBe(true);
    expect(replay.created).toBe(false);
    expect(replay.request).toEqual(first.request);
    expect(deps.schedule).toHaveBeenCalledTimes(1);
    expect(
      new Set([
        first.request.turn_id,
        first.request.user_message_id,
        first.request.assistant_message_id
      ]).size
    ).toBe(3);
    const main = await context.withDataContext(actor, (ctx) => chat.getMainThread(ctx, ids.userA));
    expect(first.request.thread_id).toBe(main?.id);
  });
  it("conflicts when the accepted source or transcript changes", async () => {
    const { service } = setup(),
      value = input();
    await service.admit(actor, value);
    for (const changed of [
      { transcript: "Delete everything" },
      { transcriptRevision: 2 },
      { automatic: false },
      { sourceFingerprint: "b".repeat(64) }
    ])
      await expect(service.admit(actor, { ...value, ...changed })).rejects.toBeInstanceOf(
        VoiceRequestConflictError
      );
  });
  it("rejects legacy input and records whitespace as no speech without dispatch", async () => {
    const { service, deps } = setup();
    await expect(
      service.admit(actor, { ...input(), version: 1 } as unknown as VoiceRequestInput)
    ).rejects.toThrow();
    const { request } = await service.admit(actor, input({ transcript: " \n\t " }));
    expect(request.state).toBe("no-speech");
    await service.send(actor, request.id);
    await service.process(actor, request.id);
    expect(deps.submit).not.toHaveBeenCalled();
    expect(deps.schedule).not.toHaveBeenCalled();
  });
  it.each([".", "...", "?!", "\u2026"])(
    "records punctuation-only transcript %j as no speech without dispatch",
    async (transcript) => {
      const { service, deps } = setup();
      const { request } = await service.admit(actor, input({ transcript }));
      expect(request.state).toBe("no-speech");
      expect(request.transcript).toBe("");
      const replay = await service.admit(
        actor,
        input({ transcript, recordingId: request.recording_id })
      );
      expect(replay.created).toBe(false);
      await service.process(actor, request.id);
      expect(deps.submit).not.toHaveBeenCalled();
      expect(deps.schedule).not.toHaveBeenCalled();
    }
  );
  it.each([
    { capturedAt: null },
    { capturedAt: new Date(now.getTime() - 900_001).toISOString() },
    { capturedAt: new Date(now.getTime() + 1).toISOString() },
    { automatic: false }
  ])("automatically queues new opted-in input regardless of timing: %j", async (override) => {
    const { service } = setup();
    const { request } = await service.admit(actor, input(override));
    expect(request).toMatchObject({ state: "queued", auto_send: true, confirmed_at: null });
    await service.process(actor, request.id);
    expect((await service.status(actor, request.id))?.state).toBe("replied");
  });
  it("preserves legacy policy, replay and one-request confirmation", async () => {
    const { service, deps } = setup();
    const value = input({ capturedAt: null, automatic: false });
    const request = await legacy(value);
    expect(request.auto_send).toBe(false);
    const replay = await service.admit(actor, value);
    expect(replay).toEqual({ created: false, request });
    expect(deps.schedule).not.toHaveBeenCalled();
    await service.process(actor, request.id);
    expect(deps.submit).not.toHaveBeenCalled();
    await service.send(actor, request.id);
    await service.process(actor, request.id);
    expect((await service.status(actor, request.id))?.state).toBe("replied");
    await expect(
      context.withDataContext(actor, (ctx) =>
        ctx.db
          .updateTable("app.chat_voice_requests")
          .set({ auto_send: true })
          .where("id", "=", request.id)
          .execute()
      )
    ).rejects.toThrow("immutable");
  });
  it("keeps new busy work automatic while legacy queued work still ages into review", async () => {
    let time = now;
    const { service, deps } = setup({
      now: () => time,
      submit: vi.fn(async () => "deferred" as const)
    });
    const { request } = await service.admit(actor, input());
    const old = await legacy(input(), "queued");
    await service.process(actor, request.id);
    time = new Date(now.getTime() + 900_001);
    await service.process(actor, request.id);
    await service.process(actor, old.id);
    expect((await service.status(actor, request.id))?.state).toBe("queued");
    expect((await service.status(actor, old.id))?.state).toBe("ready-to-send");
    expect(deps.submit).toHaveBeenCalledTimes(2);
  });
  it("pages beyond100 retained pending rows with equal timestamps without losing any", async () => {
    const { service } = setup();
    const retained = await Promise.all(Array.from({ length: 101 }, () => legacy()));
    let before: { id: string; createdAt: string } | undefined;
    const found: string[] = [];
    for (let page = 0; page < 10; page++) {
      const rows = await service.list(actor, before);
      expect(rows.length).toBeLessThanOrEqual(100);
      found.push(...rows.map((row) => row.id));
      if (rows.length < 100) break;
      const last = rows.at(-1)!;
      before = { id: last.id, createdAt: last.created_at.toISOString() };
    }
    expect(new Set(found).size).toBe(found.length);
    for (const row of retained) expect(found).toContain(row.id);
  });
  it("saves the fixed message pair and receipt atomically, then never executes a replay", async () => {
    const { service, deps } = setup();
    const { request } = await service.admit(actor, input());
    await service.process(actor, request.id);
    await service.process(actor, request.id);
    await service.send(actor, request.id);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    const rows = await context.withDataContext(actor, (ctx) =>
      ctx.db
        .selectFrom("app.chat_messages")
        .select(["id", "role"])
        .where("id", "in", [request.user_message_id, request.assistant_message_id])
        .execute()
    );
    expect(rows).toHaveLength(2);
    expect((await service.status(actor, request.id))?.state).toBe("replied");
    expect(rows.find((row) => row.role === "assistant")?.id).toBe(request.assistant_message_id);
  });
  it("recovers a committed reply when the response is lost without sending it again", async () => {
    const first = setup();
    const original = first.deps.submit;
    first.deps.submit = async (...args) => {
      await original(...args);
      throw new Error("lost response");
    };
    const { request } = await first.service.admit(actor, input());
    await expect(first.service.process(actor, request.id)).rejects.toThrow("lost response");
    const restarted = setup();
    await restarted.service.process(actor, request.id);
    expect((await restarted.service.status(actor, request.id))?.state).toBe("replied");
    expect(restarted.deps.submit).not.toHaveBeenCalled();
  });
  it("never replays a dispatched request after restart, including pre-model effects", async () => {
    const first = setup();
    const { request } = await first.service.admit(actor, input());
    await context.withDataContext(actor, (ctx) =>
      requests.claim(ctx, request.id, first.deps.bootId, now)
    );
    await first.service.process(actor, request.id);
    expect(first.deps.submit).not.toHaveBeenCalled();
    const restarted = setup();
    await restarted.service.process(actor, request.id);
    expect((await restarted.service.status(actor, request.id))?.state).toBe("interrupted");
    await restarted.service.send(actor, request.id);
    await restarted.service.process(actor, request.id);
    expect(restarted.deps.submit).not.toHaveBeenCalled();
  });
  it("marks a dispatch with an unsaved result interrupted and keeps its immutable transcript", async () => {
    const { service } = setup({
      submit: async (_a, _r, claim) => {
        await claim();
        return "executed";
      }
    });
    const { request } = await service.admit(actor, input());
    await service.process(actor, request.id);
    expect((await service.status(actor, request.id))?.state).toBe("interrupted");
    await expect(
      context.withDataContext(actor, (ctx) =>
        ctx.db
          .updateTable("app.chat_voice_requests")
          .set({ transcript: "replacement" })
          .where("id", "=", request.id)
          .execute()
      )
    ).rejects.toThrow("immutable");
  });
  it("keeps owner receipts inaccessible to another user", async () => {
    const { service } = setup();
    const { request } = await service.admit(actor, input());
    expect(await service.status(other, request.id)).toBeUndefined();
    expect(await service.send(other, request.id)).toBeUndefined();
  });
  it("exports retained source and receipt metadata through Chat and excludes boot identity", async () => {
    const { service } = setup();
    const { request } = await service.admit(actor, input());
    const exported = await context.withDataContext(actor, (ctx) =>
      collectVoiceRequestExport(ctx, { actorUserId: ids.userA, requestId: "voice-export-test" })
    );
    const row = exported.find((row) => row.id === request.id);
    expect(row?.transcript).toBe(request.transcript);
    expect(row?.turnId).toBe(request.turn_id);
    expect(row).not.toHaveProperty("dispatch_boot_id");
    expect(row).not.toHaveProperty("dispatchBootId");
  });
  it("includes voice receipts in canonical worker-role account exports with owner-only grants", async () => {
    const { service } = setup();
    const { request } = await service.admit(actor, input());
    const { request: foreign } = await service.admit(other, input());
    const worker = createDatabase({
      connectionString: connectionStrings.worker,
      maxConnections: 1
    });
    const auth = createDatabase({ connectionString: connectionStrings.auth, maxConnections: 1 });
    const workerContext = new DataContextRunner(worker);
    try {
      const exported = await workerContext.withDataContext(actor, (scopedDb) =>
        exportUserData({
          scopedDb,
          authDb: auth,
          userId: ids.userA,
          listModuleManifests: getBuiltInModuleManifests,
          requestId: "voice-worker-export"
        })
      );
      expect(exported.tables.chatVoiceRequests).toContainEqual(
        expect.objectContaining({
          id: request.id,
          transcript: request.transcript,
          turnId: request.turn_id
        })
      );
      expect(exported.tables.chatVoiceRequests).not.toContainEqual(
        expect.objectContaining({ id: foreign.id })
      );
      const visible = await workerContext.withDataContext(actor, (ctx) =>
        ctx.db.selectFrom("app.chat_voice_requests").select("id").execute()
      );
      expect(visible.map((row) => row.id)).not.toContain(foreign.id);
      await expect(
        workerContext.withDataContext(actor, (ctx) =>
          ctx.db.selectFrom("app.chat_voice_requests").select("dispatch_boot_id").execute()
        )
      ).rejects.toThrow("permission denied");
    } finally {
      await Promise.all([worker.destroy(), auth.destroy()]);
    }
  });
  it("cascades receipts when their Main chat is deleted", async () => {
    const { service } = setup();
    const { request } = await service.admit(other, input());
    // Main cannot be deleted by app SQL; account deletion uses the privileged lifecycle.
    await root.deleteFrom("app.chat_threads").where("id", "=", request.thread_id).execute();
    expect(await service.status(other, request.id)).toBeUndefined();
  });
});
