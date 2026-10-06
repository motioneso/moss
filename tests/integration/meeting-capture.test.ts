import { createPgBossClient } from "@moss/jobs";
import {
  createMeetingStopSummaryScheduler,
  registerMeetingStopSummaryWorker
} from "../../packages/meetings/src/stop-summary-jobs.js";
import { MeetingStopSummaryRepository } from "../../packages/meetings/src/stop-summary-repository.js";
import {
  MeetingPreferencesRepository,
  MEETING_SETUP_KEY
} from "../../packages/meetings/src/preferences.js";
import { PreferencesRepository } from "@moss/structured-state";
import { MEETING_RECORDING_NOTICE } from "@moss/shared";
import { MeetingRecordingNoticeRepository } from "../../packages/meetings/src/recording-notice.js";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";
import { MeetingCaptureRepository } from "../../packages/meetings/src/capture-repository.js";
import { MeetingCaptureConnectionRepository } from "../../packages/meetings/src/capture-connection-repository.js";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
let app: Kysely<MossDatabase>,
  bootstrap: Kysely<MossDatabase>,
  worker: Kysely<MossDatabase>,
  context: DataContextRunner,
  workerContext: DataContextRunner;
beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  context = new DataContextRunner(app);
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  worker = createDatabase({ connectionString: connectionStrings.worker });
  workerContext = new DataContextRunner(worker);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy(), worker?.destroy()]);
});
const inventory = {
  microphones: [{ deviceId: "mic-device", sourceId: "mic", label: "Synthetic mic" }],
  applications: [],
  computerAudio: { available: false, excludedProcessTreeIds: [] },
  microphonePermission: "granted" as const,
  systemAudioPermission: "unknown" as const
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(acknowledgeNotice = true) {
  let now = new Date(),
    revision = 1;
  const deviceId = randomUUID(),
    connectionId = randomUUID(),
    verifier = "v".repeat(43);
  const owner = { actorUserId: ids.userA },
    browser = { ...owner, sessionId: randomUUID(), expiresAt: new Date(now.getTime() + 7200000) };
  const createMeeting = async () =>
    (
      await context.withDataContext(owner, (db) =>
        new MeetingRecordsRepository().create(db, {
          title: "Synthetic capture fixture",
          requestKey: randomUUID()
        })
      )
    ).meeting;
  const meeting = await createMeeting();
  if (acknowledgeNotice)
    await context.withDataContext(owner, (db) =>
      new MeetingRecordingNoticeRepository().acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
  // Auth and provider ports are synthetic. Storage, RLS, locks, receipts and transcript are real.
  const deps: MeetingCaptureDependencies = {
    dataContext: context,
    resolveBrowser: async () => browser,
    resolveCompanion: async () => ({ ...owner, deviceId }),
    resolveRecording: async () => ({
      ...owner,
      deviceId,
      capabilityRevision: revision,
      expiresAt: browser.expiresAt
    }),
    assertRecordingBinding: async (input) => {
      if (
        input.actorUserId !== owner.actorUserId ||
        input.deviceId !== deviceId ||
        input.capabilityRevision !== revision
      )
        throw new Error("Revoked synthetic capability");
      return { expiresAt: browser.expiresAt };
    },
    assertBinding: async () => {},
    device: async () => ({ displayName: "Synthetic Mac", expiresAt: browser.expiresAt }),
    assertModuleAvailable: async () => {},
    trustedOrigins: ["https://synthetic.example"],
    processingAvailability: async () => ({ ready: true, modelRoute: "synthetic-route" }),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 900, text: "Synthetic capture evidence" }],
        modelRoute: "synthetic-route"
      }))
    ),
    now: () => now
  };
  const service = new MeetingCaptureService(deps),
    connections = new MeetingCaptureConnectionService(deps),
    native = { authorization: "Bearer tm1_synthetic", "x-moss-recording-proof": "p".repeat(43) };
  const register = () =>
    connections.register(native, "connection", {
      connectionId,
      verifierHash: hash(verifier),
      inventory
    });
  await register();
  const startInput = { requestKey: randomUUID() };
  await context.withDataContext(owner, async (db) => {
    await new MeetingPreferencesRepository().update(db, {
      defaultCaptureMode: "microphone-only",
      rememberedSource: { deviceId, microphoneId: "mic-device", mode: "microphone-only" }
    });
    await new PreferencesRepository().upsert(db, MEETING_SETUP_KEY, now.toISOString());
  });
  const start = (target = meeting.id, input = startInput) =>
    connections.start(browser, target, input);
  const begin = async () => {
    const started = await start();
    const grantId = started.capture.grantId;
    const credential = `mm1_${owner.actorUserId}.${grantId}.${"s".repeat(43)}`;
    const claim = { connectionId, verifier, grantId, credentialHash: hash(credential) };
    const activated = await connections.claim(native, "claim", claim);
    return { ...activated, credential, claim, headers: { authorization: `Bearer ${credential}` } };
  };
  return {
    deps,
    service,
    connections,
    meeting,
    browser,
    owner,
    native,
    deviceId,
    connectionId,
    verifier,
    register,
    startInput,
    start,
    begin,
    createMeeting,
    advance: (ms: number) => (now = new Date(now.getTime() + ms)),
    reapprove: () => revision++
  };
}
describe("shared meeting recording protocol (isolated gate only)", () => {
  it("stores account notice across meetings and browser sessions, binds grants, and gates stale Start/Resume replays", async () => {
    const f = await fixture(false);
    const notices = new MeetingRecordingNoticeRepository();
    await expect(f.start()).rejects.toMatchObject({ code: "meeting_capture_notice_required" });
    const acknowledgement = await context.withDataContext(f.owner, (db) =>
      notices.acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
    const started = await f.start(f.meeting.id, { ...f.startInput });
    expect(
      await context.withDataContext(f.owner, (db) =>
        new MeetingCaptureRepository().grant(db, started.capture.grantId)
      )
    ).toMatchObject({ notice_policy_version: MEETING_RECORDING_NOTICE.policyVersion });
    await f.service.cancelStart(f.browser, f.meeting.id, {
      deviceId: f.deviceId,
      connectionId: f.connectionId,
      requestKey: f.startInput.requestKey
    });
    const secondMeeting = await f.createMeeting();
    const nextBrowser = { ...f.browser, sessionId: randomUUID() };
    expect(
      await context.withDataContext(nextBrowser, (db) =>
        new MeetingRecordingNoticeRepository().get(db)
      )
    ).toEqual(acknowledgement);
    const request = { ...f.startInput, requestKey: randomUUID() };
    const second = await f.connections.start(nextBrowser, secondMeeting.id, request);
    await context.withDataContext(f.owner, (db) =>
      sql`UPDATE app.meeting_recording_notices SET policy_version='previous-text'`.execute(db.db)
    );
    await expect(f.connections.start(nextBrowser, secondMeeting.id, request)).rejects.toMatchObject(
      { code: "meeting_capture_notice_required" }
    );
    await f.service.browserControl(nextBrowser, secondMeeting.id, {
      grantId: second.capture.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "pause"
    });
    const resume = {
      grantId: second.capture.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "record" as const,
      selection: undefined
    };
    await expect(
      f.service.browserControl(nextBrowser, secondMeeting.id, resume)
    ).rejects.toMatchObject({ code: "meeting_capture_notice_required" });
    // Simulate an existing grant migrated with NULL policy binding; safe controls remain available.
    await context.withDataContext(f.owner, (db) =>
      sql`UPDATE app.meeting_capture_grants SET notice_policy_version=NULL WHERE id=${second.capture.grantId}::uuid`.execute(
        db.db
      )
    );
    await context.withDataContext(f.owner, (db) =>
      notices.acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
    await f.service.browserControl(nextBrowser, secondMeeting.id, resume);
    expect(
      await context.withDataContext(f.owner, (db) =>
        new MeetingCaptureRepository().grant(db, second.capture.grantId)
      )
    ).toMatchObject({ notice_policy_version: MEETING_RECORDING_NOTICE.policyVersion });
    await context.withDataContext(f.owner, (db) =>
      sql`UPDATE app.meeting_recording_notices SET policy_version='previous-text'`.execute(db.db)
    );
    await expect(
      f.service.browserControl(nextBrowser, secondMeeting.id, resume)
    ).rejects.toMatchObject({ code: "meeting_capture_notice_required" });
    await f.service.browserControl(nextBrowser, secondMeeting.id, {
      grantId: second.capture.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 3,
      command: "stop"
    });
  });
  it("runs the real Stop/finalized-status queue path in the dedicated owner-scoped worker", async () => {
    const enqueueBoss = createPgBossClient(connectionStrings.app),
      workerBoss = createPgBossClient(connectionStrings.worker);
    await enqueueBoss.start();
    await workerBoss.start();
    const f = await fixture(),
      active = await f.begin();
    const summaries = new MeetingStopSummaryRepository();
    Object.assign(f.deps, { scheduleSummary: createMeetingStopSummaryScheduler(enqueueBoss) });
    const generate = vi.fn(async () => ({
      content: {
        overview: "Synthetic captured meeting summary.",
        decisions: [],
        openQuestions: [],
        actions: [],
        warnings: []
      },
      modelRoute: "synthetic-configured-route"
    }));
    try {
      await registerMeetingStopSummaryWorker(workerBoss, workerContext, generate);
      f.advance(2000);
      expect(
        await f.service.audio(active.headers, "summary-evidence", {
          meetingId: f.meeting.id,
          grantId: active.grantId,
          requestKey: randomUUID(),
          generation: 1,
          epoch: 1,
          sourceId: "mic",
          sequence: 0,
          startMs: 0,
          endMs: 1000,
          sampleRateHz: 16000,
          pcmBase64: Buffer.alloc(32000, 1).toString("base64")
        })
      ).toMatchObject({ status: "saved" });
      const stop = {
        grantId: active.grantId,
        requestKey: randomUUID(),
        expectedGeneration: 1,
        command: "stop" as const
      };
      await f.service.browserControl(f.browser, f.meeting.id, stop);
      await f.service.browserControl(f.browser, f.meeting.id, stop);
      await f.service.status(active.headers, "finalized", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        inventory,
        observed: { generation: 2, phase: "stopped" },
        finalized: true,
        recordedDurationMs: 1000
      });
      await f.service.status(active.headers, "repeat-finalized", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        inventory,
        observed: { generation: 2, phase: "stopped" },
        finalized: true,
        recordedDurationMs: 1000
      });
      await expect
        .poll(() => context.withDataContext(f.owner, (db) => summaries.status(db, f.meeting.id)), {
          timeout: 20000,
          interval: 100
        })
        .toMatchObject({ status: "saved" });
      expect(generate).toHaveBeenCalledOnce();
      expect(
        (
          await context.withDataContext(f.owner, (db) =>
            sql`SELECT recorded_duration_ms FROM app.meeting_capture_grants WHERE id=${active.grantId}::uuid`.execute(
              db.db
            )
          )
        ).rows
      ).toEqual([{ recorded_duration_ms: 1000 }]);
    } finally {
      await workerBoss.stop({ graceful: true });
      await enqueueBoss.stop({ graceful: true });
    }
  });
  it("commits Stop and its immutable cutoff when optional queue SQL fails", async () => {
    const f = await fixture(),
      active = await f.begin();
    const summaries = new MeetingStopSummaryRepository();
    Object.assign(f.deps, {
      scheduleSummary: async (
        db: Parameters<MeetingStopSummaryRepository["schedule"]>[0],
        actor: Parameters<MeetingStopSummaryRepository["schedule"]>[1],
        input: Parameters<MeetingStopSummaryRepository["schedule"]>[2]
      ) =>
        summaries.schedule(db, actor, input, async (transaction) => {
          await sql`SELECT * FROM app.synthetic_unavailable_summary_queue`.execute(transaction.db);
        })
    });
    f.advance(1000);
    const stopped = await f.service.browserControl(f.browser, f.meeting.id, {
      grantId: active.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "stop"
    });
    expect(stopped.capture).toMatchObject({ desired: "stopped", stopCutoffMs: 1000 });
    await context.withDataContext(f.owner, async (db) => {
      const grant = await new MeetingCaptureRepository().grant(db, active.grantId);
      expect(JSON.parse(grant!.state_json!)).toMatchObject({
        desired: "stopped",
        stopCutoffMs: 1000
      });
      expect(await summaries.status(db, f.meeting.id)).toMatchObject({
        status: "failed",
        code: "meeting_output_queue_unavailable"
      });
    });
  });
  it("connection registration does not create meeting authority; Start enforces owner RLS", async () => {
    const f = await fixture();
    expect(
      await f.connections.commands(f.native, "commands", {
        connectionId: f.connectionId,
        verifier: f.verifier
      })
    ).toMatchObject({ command: null });
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      await expect(
        f.connections.start({ ...f.browser, actorUserId }, f.meeting.id, f.startInput)
      ).rejects.toThrow();
      expect(
        await context.withDataContext({ actorUserId }, (db) =>
          new MeetingCaptureConnectionRepository().connection(db, f.deviceId)
        )
      ).toBeNull();
    }
    await expect(f.start(randomUUID())).rejects.toThrow();
  });
  it("serializes two browser tabs per device and handles identical Start/claim retries", async () => {
    const f = await fixture();
    const second = await f.createMeeting();
    const starts = await Promise.allSettled([
      f.start(),
      f.start(second.id, { ...f.startInput, requestKey: randomUUID() })
    ]);
    expect(starts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const command = await f.connections.commands(f.native, "command", {
      connectionId: f.connectionId,
      verifier: f.verifier
    });
    expect(command.command).not.toBeNull();
    const grantId = command.command!.grantId;
    const claim = {
      connectionId: f.connectionId,
      verifier: f.verifier,
      grantId,
      credentialHash: hash(`mm1_${ids.userA}.${grantId}.${"s".repeat(43)}`)
    };
    const results = await Promise.all([
      f.connections.claim(f.native, "claim", claim),
      f.connections.claim(f.native, "retry", claim)
    ]);
    expect(results[0]?.capture.generation).toBe(results[1]?.capture.generation);
    expect(results[0]).not.toHaveProperty("credential");
    await expect(
      f.connections.claim(f.native, "changed", { ...claim, credentialHash: "a".repeat(64) })
    ).rejects.toThrow();
  });
  it("cancels the freshly claimed grant after waiting behind a concurrent claim", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(1500);
    let release!: () => void,
      blocked!: () => void,
      claimQueued!: () => void,
      cancelRead!: () => void;
    const holding = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const claimWaiting = new Promise<void>((resolve) => {
      claimQueued = resolve;
    });
    const readWaiting = new Promise<void>((resolve) => {
      cancelRead = resolve;
    });
    const blocker = context.withDataContext(f.owner, async (db) => {
      await new MeetingCaptureConnectionRepository().lock(db, f.deviceId);
      blocked();
      await gate;
    });
    await holding;
    const originalLock = f.connections.connections.lock.bind(f.connections.connections);
    vi.spyOn(f.connections.connections, "lock").mockImplementationOnce(async (db, id) => {
      claimQueued();
      await originalLock(db, id);
    });
    const claim = f.connections.claim(f.native, "concurrent-claim", {
      connectionId: f.connectionId,
      verifier: f.verifier,
      grantId: started.capture.grantId,
      credentialHash: hash(`mm1_${ids.userA}.${started.capture.grantId}.${"s".repeat(43)}`)
    });
    try {
      await Promise.race([claimWaiting, claim.then(() => undefined)]);
      await expect
        .poll(
          async () =>
            (
              await sql<{
                waiting: number;
              }>`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND query LIKE '%meeting-device:%'`.execute(
                bootstrap
              )
            ).rows[0]?.waiting ?? 0,
          { timeout: 5000, interval: 20 }
        )
        .toBeGreaterThan(0);
      const connections = new MeetingCaptureConnectionRepository();
      const originalRead = connections.byRequest.bind(connections);
      vi.spyOn(connections, "byRequest").mockImplementationOnce(async (db, key) => {
        const row = await originalRead(db, key);
        cancelRead();
        expect(row?.status).toBe("approved");
        return row;
      });
      const cancellation = new MeetingCaptureService(
        f.deps,
        new MeetingCaptureRepository(),
        undefined,
        connections
      ).cancelStart(f.browser, f.meeting.id, { requestKey: f.startInput.requestKey });
      await Promise.race([readWaiting, cancellation.then(() => undefined)]);
      release();
      await blocker;
      await claim;
      expect((await cancellation).capture).toMatchObject({
        desired: "stopped",
        stopCutoffMs: 0,
        finalization: "pending"
      });
      const stored = await context.withDataContext(f.owner, (db) =>
        new MeetingCaptureRepository().grant(db, started.capture.grantId)
      );
      expect(stored?.credential_hash).not.toBeNull();
      expect(JSON.parse(stored!.state_json!)).toMatchObject({
        desired: "stopped",
        stopCutoffMs: 0
      });
    } finally {
      release();
      await blocker;
      await claim.catch(() => undefined);
    }
  });
  it("rejects old launch generations, changed proofs and capability reapproval", async () => {
    const f = await fixture();
    const active = await f.begin();
    await expect(
      f.connections.claim(f.native, "wrong", { ...active.claim, verifier: "x".repeat(43) })
    ).rejects.toThrow();
    f.reapprove();
    expect((await f.register()).revision).toBe(2);
    await expect(f.connections.claim(f.native, "old", active.claim)).rejects.toThrow();
    await expect(
      f.service.status(active.headers, "old", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        inventory,
        observed: { generation: 1, phase: "recording" }
      })
    ).rejects.toThrow();
    expect(
      await f.connections.commands(f.native, "command", {
        connectionId: f.connectionId,
        verifier: f.verifier
      })
    ).toMatchObject({ command: null });
  });
  it.each(["acknowledged", "deadline"] as const)(
    "Stop releases the recorder after %s finalization",
    async (finish) => {
      const f = await fixture(),
        active = await f.begin();
      await f.service.status(active.headers, "recording", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        inventory,
        observed: { generation: 1, phase: "recording" }
      });
      f.advance(2000);
      const stopped = await f.service.browserControl(f.browser, f.meeting.id, {
        grantId: active.grantId,
        requestKey: randomUUID(),
        expectedGeneration: 1,
        command: "stop"
      });
      const acknowledged = await f.service.status(active.headers, "stopped", {
        meetingId: f.meeting.id,
        grantId: active.grantId,
        inventory,
        observed: { generation: 2, phase: "stopped" }
      });
      expect(acknowledged.capture.finalization).toBe("pending");
      const second = await f.createMeeting(),
        secondInput = { ...f.startInput, requestKey: randomUUID() };
      await expect(f.start(second.id, secondInput)).rejects.toMatchObject({
        code: "meeting_capture_busy"
      });
      if (finish === "acknowledged")
        await f.service.status(active.headers, "finalized", {
          meetingId: f.meeting.id,
          grantId: active.grantId,
          inventory,
          observed: { generation: 2, phase: "stopped" },
          finalized: true
        });
      else f.advance(60001);
      await f.register();
      const next = await f.start(second.id, secondInput);
      expect(next.capture.recordedDurationMs).toBe(0);
      expect(next.capture.grantId).not.toBe(active.grantId);
      expect((await f.service.browserStatus(f.browser, f.meeting.id)).capture?.stopCutoffMs).toBe(
        stopped.capture.stopCutoffMs
      );
    }
  );
  it("holds a fresh Start for its claim window, and cancels an unclaimed Stop immediately", async () => {
    const f = await fixture();
    const started = await f.start();
    f.advance(35000);
    await f.register();
    expect((await f.service.browserStatus(f.browser, f.meeting.id)).capture?.desired).toBe(
      "recording"
    );
    const stopped = await f.service.browserControl(f.browser, f.meeting.id, {
      grantId: started.capture.grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "stop"
    });
    expect(stopped.capture.finalization).toBe("complete");
    expect(
      await f.connections.commands(f.native, "cancelled", {
        connectionId: f.connectionId,
        verifier: f.verifier
      })
    ).toMatchObject({ command: null });
    const next = await f.createMeeting();
    expect(
      (await f.start(next.id, { ...f.startInput, requestKey: randomUUID() })).capture.desired
    ).toBe("recording");
  });
  it("acknowledges Pause before native claim and explicitly requeues Resume with a fresh clock", async () => {
    const f = await fixture(),
      started = await f.start(),
      grantId = started.capture.grantId;
    const paused = await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "pause"
    });
    expect(paused.capture.observed).toMatchObject({ phase: "paused", generation: 2 });
    expect(
      await f.connections.commands(f.native, "paused", {
        connectionId: f.connectionId,
        verifier: f.verifier
      })
    ).toMatchObject({ command: null });
    f.advance(65000);
    await f.register();
    const readiness = await f.service.browserStatus(f.browser, f.meeting.id);
    expect(readiness.capture?.lastSeenAt).not.toBe(started.capture.lastSeenAt);
    await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 2,
      command: "record",
      selection: undefined
    });
    const claim = {
      connectionId: f.connectionId,
      verifier: f.verifier,
      grantId,
      credentialHash: hash(`mm1_${ids.userA}.${grantId}.${"s".repeat(43)}`)
    };
    expect((await f.connections.claim(f.native, "resume", claim)).capture).toMatchObject({
      desired: "recording",
      generation: 3,
      epoch: 1,
      epochStartMs: 0,
      recordedDurationMs: 0,
      observed: null
    });
  });
  it("persists an owner-only cancellation fence before any Start is received", async () => {
    const f = await fixture();
    expect(await f.service.cancelStart(f.browser, f.meeting.id, f.startInput)).toEqual({
      cancelled: true,
      capture: null
    });
    await expect(f.start()).rejects.toMatchObject({ code: "meeting_capture_conflict" });
    expect(
      await f.connections.commands(f.native, "cancelled", {
        connectionId: f.connectionId,
        verifier: f.verifier
      })
    ).toMatchObject({ command: null });
  });
  it("releases an orphaned claimed Start after the capture lease instead of blocking for two hours", async () => {
    const f = await fixture();
    await f.begin();
    f.advance(30001);
    await f.register();
    const second = await f.createMeeting();
    expect(
      (await f.start(second.id, { ...f.startInput, requestKey: randomUUID() })).capture.generation
    ).toBe(1);
  });
  it("persists metadata receipts without audio or secrets and fences exact Stop cutoffs", async () => {
    const f = await fixture(),
      active = await f.begin(),
      grantId = active.grantId;
    await f.service.status(active.headers, "recording", {
      meetingId: f.meeting.id,
      grantId,
      inventory,
      observed: { generation: 1, phase: "recording" }
    });
    f.advance(2000);
    const clip = {
      meetingId: f.meeting.id,
      grantId,
      requestKey: randomUUID(),
      generation: 1,
      epoch: 1,
      sourceId: "mic",
      sequence: 0,
      startMs: 0,
      endMs: 1000,
      sampleRateHz: 16000,
      pcmBase64: Buffer.alloc(32000, 1).toString("base64")
    };
    expect(await f.service.audio(active.headers, "audio", clip)).toMatchObject({ status: "saved" });
    expect(await f.service.audio(active.headers, "replay", clip)).toMatchObject({
      status: "saved",
      replayed: true
    });
    expect(f.deps.transcribe).toHaveBeenCalledOnce();
    const transcript = await context.withDataContext(f.owner, (db) =>
      new MeetingTranscriptRepository().snapshotWithSources(db, f.meeting.id, {
        maxSegments: 50,
        maxCharacters: 10000
      })
    );
    expect(transcript?.snapshot.segments[0]?.text).toBe("Synthetic capture evidence");
    const stored = await context.withDataContext(f.owner, (db) =>
      sql`SELECT metadata_json,result_json FROM app.meeting_capture_receipts WHERE grant_id=${grantId}::uuid`.execute(
        db.db
      )
    );
    expect(JSON.stringify(stored.rows)).not.toContain(clip.pcmBase64);
    expect(JSON.stringify(stored.rows)).not.toContain(active.credential);
    expect(JSON.stringify(stored.rows)).not.toContain("Synthetic capture evidence");
    const stopped = await f.service.browserControl(f.browser, f.meeting.id, {
      grantId,
      requestKey: randomUUID(),
      expectedGeneration: 1,
      command: "stop"
    });
    await f.service.status(active.headers, "stopped", {
      meetingId: f.meeting.id,
      grantId,
      inventory,
      observed: { generation: 2, phase: "stopped" }
    });
    await expect(
      f.service.audio(active.headers, "late", {
        ...clip,
        requestKey: randomUUID(),
        sequence: 1,
        startMs: 1001,
        endMs: 2001
      })
    ).rejects.toThrow();
    const head = await context.withDataContext(f.owner, (db) =>
      new MeetingCaptureRepository().transcriptHead(db, f.meeting.id)
    );
    expect(head.stop_cutoff_ms).toBe(stopped.capture.stopCutoffMs);
  });
  it("reconciles abandoned processing into one gap without unchanged-read writes", async () => {
    const f = await fixture(),
      active = await f.begin(),
      grantId = active.grantId;
    const status = () =>
      f.service.status(active.headers, "status", {
        meetingId: f.meeting.id,
        grantId,
        inventory,
        observed: { generation: 1, phase: "recording" }
      });
    await status();
    const requestKey = randomUUID();
    await context.withDataContext(f.owner, (db) =>
      new MeetingCaptureRepository().reserve(db, grantId, {
        requestKey,
        kind: "audio",
        fingerprint: "e".repeat(64),
        metadata: { sourceId: "mic", epoch: 1, generation: 1, sequence: 0, startMs: 0, endMs: 5000 }
      })
    );
    for (let index = 0; index < 6; index++) {
      f.advance(5000);
      await status();
    }
    f.advance(120000);
    const first = await f.service.browserStatus(f.browser, f.meeting.id),
      second = await f.service.browserStatus(f.browser, f.meeting.id);
    expect(first.capture?.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ startMs: 0, endMs: 5000, reason: "interrupted" }),
        expect.objectContaining({ startMs: 30000, endMs: 60000, reason: "interrupted" })
      ])
    );
    expect(second.capture?.gaps).toEqual(first.capture?.gaps);
    expect(second.revision).toBe(first.revision);
  });
});
class CaptureIsolationProbeError extends Error {}
function assertInvisible(rows: readonly unknown[]) {
  if (rows.length) throw new CaptureIsolationProbeError("Capture owner isolation assertion failed");
}
describe("capture owner and worker isolation", () => {
  for (const [table, key] of [
    ["app.meeting_capture_connections", "device_id"],
    ["app.meeting_capture_grants", "id"],
    ["app.meeting_capture_receipts", "grant_id"],
    ["app.meeting_capture_start_cancellations", "request_key"]
  ] as const) {
    it(`${table} rejects other owners/admins and detects rollback-only RLS removal`, async () => {
      assertIsolatedTestDatabase(connectionStrings.bootstrap);
      const databaseName = new URL(connectionStrings.bootstrap).pathname.slice(1);
      if (!/^(jarvis_gate_|jarvis_test_)/.test(databaseName))
        throw Error("Disposable database required");
      const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(
        bootstrap
      );
      expect(database.rows[0]?.name).toBe(databaseName);
      const f = await fixture(),
        active = await f.begin();
      await context.withDataContext(f.owner, (db) =>
        new MeetingCaptureRepository().reserve(db, active.grantId, {
          requestKey: randomUUID(),
          kind: "control",
          fingerprint: "c".repeat(64),
          metadata: { command: "stop" },
          result: { status: "synthetic" }
        })
      );
      if (key === "request_key") await f.service.cancelStart(f.browser, f.meeting.id, f.startInput);
      const id =
        key === "device_id"
          ? f.deviceId
          : key === "request_key"
            ? f.startInput.requestKey
            : active.grantId;
      const protectedCheck = (actorUserId: string) =>
        context.withDataContext({ actorUserId }, async (db) =>
          assertInvisible(
            (
              await sql`SELECT ${sql.ref(key)} FROM ${sql.ref(table)} WHERE ${sql.ref(key)}=${id}::uuid`.execute(
                db.db
              )
            ).rows
          )
        );
      for (const actor of [ids.userB, ids.adminUser]) await protectedCheck(actor);
      await expect(
        bootstrap.transaction().execute(async (transaction) => {
          await sql`ALTER TABLE ${sql.ref(table)} DISABLE ROW LEVEL SECURITY`.execute(transaction);
          await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
          await sql`SELECT set_config('app.actor_user_id',${ids.userB},true)`.execute(transaction);
          const leaked =
            await sql`SELECT ${sql.ref(key)} FROM ${sql.ref(table)} WHERE ${sql.ref(key)}=${id}::uuid`.execute(
              transaction
            );
          expect(leaked.rows).toHaveLength(1);
          assertInvisible(leaked.rows);
          throw Error("Mutation did not defeat owner isolation");
        })
      ).rejects.toBeInstanceOf(CaptureIsolationProbeError);
      const restored = await sql<{
        enabled: boolean;
        forced: boolean;
      }>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid=${table}::regclass`.execute(
        bootstrap
      );
      expect(restored.rows).toEqual([{ enabled: true, forced: true }]);
      await protectedCheck(ids.userB);
    });
  }
  it("workers can read owner capture history but never recording proof, session, or command metadata", async () => {
    const f = await fixture(),
      active = await f.begin();
    const read = (actorUserId: string) =>
      workerContext.withDataContext({ actorUserId }, (db) =>
        sql`SELECT id,meeting_id,owner_user_id,device_name,status,state_json,created_at,expires_at FROM app.meeting_capture_grants WHERE id=${active.grantId}::uuid`.execute(
          db.db
        )
      );
    expect((await read(ids.userA)).rows).toHaveLength(1);
    expect((await read(ids.userB)).rows).toEqual([]);
    expect((await read(ids.adminUser)).rows).toEqual([]);
    for (const column of [
      "credential_hash",
      "verifier_hash",
      "session_id",
      "connection_id",
      "capability_revision"
    ])
      await expect(
        workerContext.withDataContext(f.owner, (db) =>
          sql`SELECT ${sql.ref(column)} FROM app.meeting_capture_grants WHERE id=${active.grantId}::uuid`.execute(
            db.db
          )
        )
      ).rejects.toMatchObject({ code: "42501" });
    for (const table of [
      "app.meeting_capture_links",
      "app.meeting_capture_connections",
      "app.meeting_capture_start_cancellations",
      "app.meeting_capture_receipts"
    ])
      await expect(
        workerContext.withDataContext(f.owner, (db) =>
          sql`SELECT * FROM ${sql.ref(table)}`.execute(db.db)
        )
      ).rejects.toMatchObject({ code: "42501" });
  });
});
