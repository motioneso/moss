import { MeetingStopSummaryRepository } from "../../packages/meetings/src/stop-summary-repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureInventory
} from "@moss/shared";
import {
  applyCaptureControl,
  assertCaptureAudioAdmission,
  decodeCaptureAudio,
  expireCaptureLease,
  pcmWave,
  retainCaptureGap,
  type CaptureStoredState
} from "../../packages/meetings/src/capture-domain.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant,
  type CaptureReceipt
} from "../../packages/meetings/src/capture-repository.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
import { MeetingCaptureConnectionRepository } from "../../packages/meetings/src/capture-connection-repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const meetingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const grantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const origin = new Date("2026-10-05T00:00:00Z");
const at = (ms: number) => new Date(origin.getTime() + ms);
const inventory: MeetingCaptureInventory = {
  microphones: [{ deviceId: "mic-device", sourceId: "mic", label: "Selected microphone" }],
  applications: [{ appProcessTreeId: "selected-app", label: "Selected app" }],
  computerAudio: { available: true, excludedProcessTreeIds: ["moss"] },
  microphonePermission: "granted",
  systemAudioPermission: "granted"
};
function state(): CaptureStoredState {
  return {
    gaps: [],
    gapLimitReached: false,
    generation: 0,
    desired: "idle",
    originAt: origin.toISOString(),
    epochs: [],
    stopCutoffMs: null,
    finalizationDeadline: null,
    inventory,
    observed: { generation: 0, phase: "idle" },
    lastSeenAt: origin.toISOString()
  };
}
function command(
  command: MeetingCaptureControlInput["command"],
  generation: number
): MeetingCaptureControlInput {
  return {
    grantId,
    requestKey: randomUUID(),
    expectedGeneration: generation,
    command,
    ...(command === "record"
      ? {
          selection: {
            mode: "microphone-only" as const,
            microphone: { deviceId: "mic-device", sourceId: "mic" }
          }
        }
      : {})
  };
}
function recording() {
  const value = state();
  applyCaptureControl(value, command("record", 0), origin, "route");
  value.observed = { generation: 1, phase: "recording" };
  value.lastSeenAt = at(2000).toISOString();
  return value;
}
function audio(): MeetingCaptureAudioInput {
  return {
    meetingId,
    grantId,
    requestKey: randomUUID(),
    generation: 1,
    epoch: 1,
    sourceId: "mic",
    sequence: 0,
    startMs: 0,
    endMs: 1000,
    sampleRateHz: 16000,
    pcmBase64: Buffer.alloc(32000).toString("base64")
  };
}
describe("native capture bounded domain", () => {
  it("retains exact gap replay, rejects changed IDs, and pauses visibly at its bounded cap", () => {
    const value = recording();
    const gap = {
      id: randomUUID(),
      sourceId: "mic",
      epoch: 1,
      startMs: 0,
      endMs: 1000,
      reason: "discarded" as const
    };
    retainCaptureGap(value, gap, at(2000));
    retainCaptureGap(value, gap, at(2000));
    expect(value.gaps).toHaveLength(1);
    expect(() => retainCaptureGap(value, { ...gap, endMs: 1001 }, at(2000))).toThrow();
    for (let i = 1; i < 257; i++) retainCaptureGap(value, { ...gap, id: randomUUID() }, at(2000));
    expect(value.gaps).toHaveLength(256);
    expect(value.gapLimitReached).toBe(true);
    expect(value.desired).toBe("paused");
    expect(() =>
      applyCaptureControl(value, command("record", value.generation), at(2000))
    ).toThrow();
  });
  it("validates exact duration, mono PCM bytes and original sample rate", () => {
    expect(decodeCaptureAudio(audio()).pcm.length).toBe(32000);
    expect(() => decodeCaptureAudio({ ...audio(), endMs: 1004 })).toThrow();
    expect(() => decodeCaptureAudio({ ...audio(), pcmBase64: "bad!" })).toThrow();
    expect(() => decodeCaptureAudio({ ...audio(), endMs: 10001 })).toThrow();
    const wave = Buffer.from(pcmWave(Buffer.alloc(192000), 48000));
    expect(wave.readUInt32LE(24)).toBe(48000);
    expect(wave.readUInt16LE(22)).toBe(1);
    expect(wave.readUInt32LE(40)).toBe(192000);
  });
  it("changes fingerprints when same request is rebound to another source/sequence/audio", () => {
    const clip = audio();
    const fingerprint = decodeCaptureAudio(clip).fingerprint;
    expect(decodeCaptureAudio({ ...clip, sourceId: "output" }).fingerprint).not.toBe(fingerprint);
    expect(decodeCaptureAudio({ ...clip, sequence: 1 }).fingerprint).not.toBe(fingerprint);
    expect(
      decodeCaptureAudio({ ...clip, pcmBase64: Buffer.alloc(32000, 1).toString("base64") })
        .fingerprint
    ).not.toBe(fingerprint);
  });
  it("rejects wrong generation, missing recording acknowledgement and unselected output", () => {
    const value = recording();
    expect(assertCaptureAudioAdmission(value, audio(), at(2000)).epoch).toBe(1);
    expect(() =>
      assertCaptureAudioAdmission(value, { ...audio(), generation: 2 }, at(2000))
    ).toThrow();
    expect(() =>
      assertCaptureAudioAdmission(value, { ...audio(), sourceId: "output" }, at(2000))
    ).toThrow();
    value.observed = { generation: 0, phase: "recording" };
    expect(() => assertCaptureAudioAdmission(value, audio(), at(2000))).toThrow();
  });
  it("Pause closes admission and Resume creates a separately approved epoch", () => {
    const value = recording();
    applyCaptureControl(value, command("pause", 1), at(2000));
    expect(() => assertCaptureAudioAdmission(value, audio(), at(2000))).toThrow();
    applyCaptureControl(value, command("record", 2), at(3000), "route");
    expect(value.epochs.map((e) => [e.epoch, e.generation, e.endMs])).toEqual([
      [1, 1, 2000],
      [2, 3, null]
    ]);
    expect(() => assertCaptureAudioAdmission(value, audio(), at(4000))).toThrow();
  });
  it("keeps Stop immutable and allows only acknowledged pre-cutoff final flush for60seconds", () => {
    const value = recording();
    applyCaptureControl(value, command("stop", 1), at(2000));
    expect(() => assertCaptureAudioAdmission(value, audio(), at(3000))).toThrow();
    value.observed = { generation: 2, phase: "stopped" };
    expect(assertCaptureAudioAdmission(value, audio(), at(3000)).epoch).toBe(1);
    expect(() =>
      assertCaptureAudioAdmission(value, { ...audio(), endMs: 2001 }, at(3000))
    ).toThrow();
    applyCaptureControl(value, command("stop", 2), at(10000));
    expect(value.stopCutoffMs).toBe(2000);
    expect(value.finalizationDeadline).toBe(at(62000).toISOString());
    expect(() => assertCaptureAudioAdmission(value, audio(), at(62001))).toThrow();
  });
  it("expires a silent lease without resuming from a stale observed generation", () => {
    const value = recording();
    expireCaptureLease(value, at(32001));
    expect(value.desired).toBe("paused");
    expect(value.generation).toBe(2);
    expect(() => assertCaptureAudioAdmission(value, audio(), at(33000))).toThrow();
    expect(() => applyCaptureControl(value, command("record", 2), at(33000))).toThrow();
  });
  it("freezes lease cutoff at last contact plus30seconds even on a next-day read", () => {
    const value = recording();
    expireCaptureLease(value, at(86400000));
    expect(value.epochs[0]?.endMs).toBe(32000);
    expect(value.gaps.map((gap) => [gap.startMs, gap.endMs])).toEqual([[2000, 32000]]);
    expireCaptureLease(value, at(172800000));
    expect(value.epochs[0]?.endMs).toBe(32000);
    expect(value.gaps).toHaveLength(1);
    const short = recording();
    expireCaptureLease(short, at(86400000), at(5000));
    expect(short.epochs[0]?.endMs).toBe(5000);
  });
  it("admits retained pre-pause audio only after explicit acknowledged Resume and within its age bound", () => {
    const value = recording();
    const clip = audio();
    applyCaptureControl(value, command("pause", 1), at(2000));
    expect(() => assertCaptureAudioAdmission(value, clip, at(3000))).toThrow();
    value.lastSeenAt = at(3000).toISOString();
    applyCaptureControl(value, command("record", 2), at(3000), "route");
    expect(() => assertCaptureAudioAdmission(value, clip, at(4000))).toThrow();
    value.observed = { generation: 3, phase: "recording" };
    value.lastSeenAt = at(4000).toISOString();
    expect(assertCaptureAudioAdmission(value, clip, at(4000)).epoch).toBe(1);
    value.lastSeenAt = at(62000).toISOString();
    expect(() => assertCaptureAudioAdmission(value, clip, at(62000))).toThrow();
  });
  it("does not broaden a selected app or silently change computer exclusions", () => {
    const value = state();
    const input = command("record", 0);
    expect(() =>
      applyCaptureControl(
        value,
        {
          ...input,
          selection: {
            mode: "selected-app",
            microphone: { deviceId: "mic-device", sourceId: "mic" },
            outputSourceId: "output",
            appProcessTreeId: "unknown"
          }
        },
        origin
      )
    ).toThrow();
    expect(() =>
      applyCaptureControl(
        value,
        {
          ...input,
          selection: {
            mode: "computer-audio",
            microphone: { deviceId: "mic-device", sourceId: "mic" },
            outputSourceId: "output",
            scope: { kind: "process-exclusion", excludedProcessTreeIds: [] }
          }
        },
        origin
      )
    ).toThrow();
  });
});
function fixture() {
  let active = 0;
  const value = recording();
  const credential = `mm1_${owner}.${grantId}.${"s".repeat(43)}`;
  const grant: CaptureGrant = {
    id: grantId,
    meeting_id: meetingId,
    owner_user_id: owner,
    device_id: deviceId,
    device_name: "Synthetic Mac",
    verifier_hash: "a".repeat(64),
    credential_hash: createHash("sha256").update(credential).digest("hex"),
    session_id: randomUUID(),
    status: "active",
    connection_id: deviceId,
    capability_revision: 1,
    created_at: origin,
    expires_at: at(7200000),
    state_json: JSON.stringify(value)
  };
  const repository = new MeetingCaptureRepository();
  const receipts = new Map<string, CaptureReceipt>();
  vi.spyOn(repository, "reconcileExpiredAudio").mockResolvedValue();
  vi.spyOn(repository, "hasPendingAudio").mockResolvedValue(false);
  vi.spyOn(repository, "lockMeeting").mockResolvedValue();
  vi.spyOn(repository, "grant").mockImplementation(async () => grant);
  vi.spyOn(repository, "save").mockImplementation(async (_db, _grant, next) => {
    grant.state_json = JSON.stringify(next);
    if (next.desired === "revoked") grant.status = "revoked";
  });
  vi.spyOn(repository, "receipt").mockImplementation(async (_db, _id, key, fingerprint) => {
    const row = receipts.get(key);
    if (row && row.fingerprint !== fingerprint) throw Error("conflict");
    return row ?? null;
  });
  vi.spyOn(repository, "reserve").mockImplementation(async (_db, _id, input) => {
    receipts.set(input.requestKey, {
      request_key: input.requestKey,
      kind: input.kind,
      fingerprint: input.fingerprint,
      metadata_json: JSON.stringify(input.metadata),
      result_json: input.result ? JSON.stringify(input.result) : null,
      created_at: at(2000)
    });
  });
  vi.spyOn(repository, "admitAudio").mockImplementation(async (db, _grant, input, fingerprint) =>
    repository.reserve(db, grantId, {
      requestKey: input.requestKey,
      kind: "audio",
      fingerprint,
      metadata: {}
    })
  );
  vi.spyOn(repository, "finish").mockImplementation(async (_db, _id, result) => {
    const receipt = receipts.get(result.requestKey);
    if (receipt) receipt.result_json = JSON.stringify(result);
  });
  vi.spyOn(repository, "transcriptHead").mockResolvedValue({
    version: 0,
    cursor: 0,
    transcript_revision: 0,
    stop_cutoff_ms: null
  });
  const transcript = new MeetingTranscriptRepository();
  vi.spyOn(transcript, "snapshotWithSources").mockResolvedValue(null);
  const ingest = vi.spyOn(transcript, "ingest").mockResolvedValue({
    status: "saved",
    replayed: false,
    receipt: { version: 1, cursor: 1, transcriptRevision: 1, stopCutoffMs: null }
  });
  const deps: MeetingCaptureDependencies = {
    dataContext: {
      withDataContext: async (_actor, run) => {
        active++;
        try {
          return await run({} as Parameters<typeof run>[0]);
        } finally {
          active--;
        }
      }
    },
    resolveBrowser: vi.fn(),
    resolveCompanion: vi.fn(),
    acquireRecordingBinding: async () => ({ release: async () => {} }),
    scheduleMaintenance: async () => {},
    assertRecordingBinding: vi.fn(async () => ({ expiresAt: at(7200000) })),
    assertBinding: vi.fn(async () => {
      expect(active).toBeLessThanOrEqual(1);
    }),
    device: vi.fn(),
    assertModuleAvailable: vi.fn(async () => {
      expect(active).toBe(0);
    }),
    processingAvailability: vi.fn(async () => ({ ready: true, modelRoute: "route" })),
    transcribe: vi.fn(async (_actor, input) =>
      input.dispatch(async () => ({
        segments: [{ startMs: 0, endMs: 900, text: "Synthetic transcript" }],
        modelRoute: "route"
      }))
    ),
    trustedOrigins: ["https://moss.example"],
    now: () => at(2000)
  };
  const connections = new MeetingCaptureConnectionRepository();
  vi.spyOn(connections, "lock").mockResolvedValue();
  vi.spyOn(connections, "connection").mockImplementation(async () => ({
    owner_user_id: owner,
    device_id: deviceId,
    connection_id: deviceId,
    device_name: "Mac",
    verifier_hash: grant.verifier_hash,
    capability_revision: 1,
    revision: 1,
    inventory_json: JSON.stringify(inventory),
    last_seen_at: at(2000),
    expires_at: at(7200000)
  }));
  const preferences = new MeetingPreferencesRepository();
  vi.spyOn(preferences, "get").mockResolvedValue({
    rememberedSource: { deviceId, microphoneId: "mic-device", mode: "microphone-only" },
    defaultCaptureMode: "microphone-only",
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
  vi.spyOn(connections, "lockRequest").mockResolvedValue();
  const service = new MeetingCaptureService(deps, repository, transcript, connections, preferences);
  return {
    deps,
    service,
    preferences,
    grant,
    ingest,
    repository,
    receipts,
    headers: { authorization: `Bearer ${credential}` },
    browser: { actorUserId: owner, sessionId: grant.session_id!, expiresAt: grant.expires_at }
  };
}
describe("capture service authorization and dispatch", () => {
  it("resumes and replays the same command without creating another epoch", async () => {
    const f = fixture();
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    const resume = { ...command("record", 2), selection: undefined };
    await f.service.browserControl(f.browser, meetingId, resume);
    await f.service.browserControl(f.browser, meetingId, resume);
    expect(JSON.parse(f.grant.state_json!).generation).toBe(3);
  });
  it("resumes a fresh default on the same grant Mac without saved hardware", async () => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: null,
      defaultCaptureMode: "computer-audio",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    const result = await f.service.browserControl(f.browser, meetingId, {
      ...command("record", 2),
      selection: undefined
    });
    expect(result.capture).toMatchObject({
      deviceId,
      selection: { mode: "computer-audio", microphone: { deviceId: "mic-device" } }
    });
  });
  it("never moves an existing grant to a newly remembered Mac", async () => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: {
        deviceId: meetingId,
        microphoneId: "mic-device",
        mode: "microphone-only"
      },
      defaultCaptureMode: "microphone-only",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    await expect(
      f.service.browserControl(f.browser, meetingId, {
        ...command("record", 2),
        selection: undefined
      })
    ).rejects.toMatchObject({ code: "meeting_capture_source_unavailable" });
    expect(JSON.parse(f.grant.state_json!).desired).toBe("paused");
  });
  it("commits Stop if optional summary enqueue fails", async () => {
    const f = fixture();
    const row = {
      meeting_id: meetingId,
      owner_user_id: owner,
      grant_id: grantId,
      request_key: randomUUID(),
      template_id: "general",
      status: "waiting",
      code: null,
      due_at: at(62000),
      created_at: at(2000),
      early_enqueued: false,
      input_json: null
    };
    const recorded = makeRecordingDb({ rows: [row] });
    const preferences = new MeetingPreferencesRepository();
    vi.spyOn(preferences, "get").mockResolvedValue({
      defaultCaptureMode: null,
      rememberedSource: null,
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    const automatic = new MeetingStopSummaryRepository(preferences);
    vi.spyOn(automatic, "row").mockResolvedValue(null);
    Object.assign(f.deps, {
      scheduleSummary: async (
        _db: unknown,
        actor: Parameters<MeetingStopSummaryRepository["schedule"]>[1],
        input: Parameters<MeetingStopSummaryRepository["schedule"]>[2]
      ) =>
        automatic.schedule(recorded.scoped, actor, input, async () => {
          throw new Error("Synthetic unavailable queue");
        })
    });
    await expect(
      f.service.browserControl(f.browser, meetingId, command("stop", 1))
    ).resolves.toMatchObject({ capture: { desired: "stopped", stopCutoffMs: 2000 } });
    expect(recorded.queries.some((query) => query.sql.includes("ROLLBACK TO SAVEPOINT"))).toBe(
      true
    );
    expect(
      recorded.queries.some((query) =>
        query.parameters.includes("meeting_output_queue_unavailable")
      )
    ).toBe(true);
  });
  it("keeps safe Stop acknowledgements and bounded final flush available after the gap cap", async () => {
    const f = fixture();
    const value = recording();
    const gap = {
      id: randomUUID(),
      sourceId: "mic",
      epoch: 1,
      startMs: 0,
      endMs: 1000,
      reason: "discarded" as const
    };
    for (let i = 0; i < 256; i++) retainCaptureGap(value, { ...gap, id: randomUUID() }, at(2000));
    f.grant.state_json = JSON.stringify(value);
    const overflow = await f.service.status(f.headers, "overflow", {
      meetingId,
      grantId,
      inventory,
      observed: { generation: 1, phase: "recording" },
      gaps: [gap]
    });
    expect(overflow.capture).toMatchObject({
      desired: "paused",
      generation: 2,
      gapLimitReached: true,
      observed: { phase: "error", errorCode: "meeting_capture_limit" }
    });
    const stopped = await f.service.browserControl(f.browser, meetingId, command("stop", 2));
    expect(stopped.capture).toMatchObject({
      desired: "stopped",
      generation: 3,
      stopCutoffMs: 2000
    });
    const acknowledged = await f.service.status(f.headers, "stopped", {
      meetingId,
      grantId,
      inventory,
      observed: { generation: 3, phase: "stopped" },
      gaps: [gap]
    });
    expect(acknowledged.capture).toMatchObject({
      desired: "stopped",
      generation: 3,
      gapLimitReached: true,
      observed: { generation: 3, phase: "stopped", errorCode: "meeting_capture_limit" }
    });
    expect(acknowledged.capture.gaps).toHaveLength(256);
    expect(await f.service.audio(f.headers, "final-flush", audio())).toMatchObject({
      status: "saved"
    });
    await expect(
      f.service.audio(f.headers, "past-cutoff", {
        ...audio(),
        requestKey: randomUUID(),
        sequence: 1,
        startMs: 1001,
        endMs: 2001
      })
    ).rejects.toThrow();
  });
  it("persists server-derived text once and replays receipts without provider redispatch", async () => {
    const f = fixture(),
      input = audio();
    expect(await f.service.audio(f.headers, "request", input)).toMatchObject({
      status: "saved",
      transcriptRevision: 1
    });
    expect(await f.service.audio(f.headers, "request", input)).toMatchObject({
      status: "saved",
      replayed: true
    });
    expect(f.deps.transcribe).toHaveBeenCalledTimes(1);
    expect(f.ingest.mock.calls[0]?.[1].events[0]?.segment).toMatchObject({
      sourceId: "mic",
      speakerId: null,
      text: "Synthetic transcript",
      startMs: 0,
      endMs: 900
    });
    expect(JSON.stringify([...f.receipts.values()])).not.toContain(input.pcmBase64);
  });
  it.each([0, 1, 99, 100])(
    "persists and clamps a provider end %dms beyond the clip without extending its source",
    async (overshoot) => {
      const f = fixture();
      const input = { ...audio(), startMs: 500, endMs: 1500 };
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, request) =>
        request.dispatch(async () => ({
          segments: [{ startMs: 20, endMs: 1000 + overshoot, text: "Rounded provider result" }],
          modelRoute: "route"
        }))
      );
      expect(await f.service.audio(f.headers, "rounded-end", input)).toMatchObject({
        status: "saved"
      });
      expect(f.ingest.mock.calls[0]?.[1].events[0]?.segment).toMatchObject({
        startMs: 520,
        endMs: 1500
      });
      expect(f.ingest.mock.calls[0]?.[1].sources[0]?.endMs).toBe(1500);
      expect(JSON.parse(f.grant.state_json!).gaps).toEqual([]);
    }
  );
  it.each([
    [0, 1101],
    [0, 1500],
    [-1, 1000],
    [1000, 1001],
    [1001, 1100],
    [500, 500],
    [600, 500],
    [Number.NaN, 1000],
    [0, Number.POSITIVE_INFINITY],
    [0, 1000.5]
  ])(
    "rejects invalid provider interval %s..%s without transcript persistence",
    async (startMs, endMs) => {
      const f = fixture();
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, request) =>
        request.dispatch(async () => ({
          segments: [{ startMs, endMs, text: "Invalid provider result" }],
          modelRoute: "route"
        }))
      );
      expect(await f.service.audio(f.headers, "invalid-end", audio())).toMatchObject({
        status: "failed",
        reason: "timestamp-or-content-invalid",
        retryable: false
      });
      expect(f.ingest).not.toHaveBeenCalled();
    }
  );
  it.each(["tm1_wrong", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "mm1_bad"])(
    "rejects other credential families %s before data access",
    async (token) => {
      const f = fixture();
      await expect(
        f.service.audio({ authorization: `Bearer ${token}` }, "request", audio())
      ).rejects.toThrow();
      expect(f.repository.grant).not.toHaveBeenCalled();
      expect(f.deps.transcribe).not.toHaveBeenCalled();
    }
  );
  it.each(["pause", "revoke"] as const)(
    "blocks provider initiation after %s wins while adapter prepares",
    async (operation) => {
      const f = fixture();
      let release!: () => void;
      let prepared!: () => void;
      const preparation = new Promise<void>((resolve) => {
        prepared = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const initiate = vi.fn(async () => ({ segments: [], modelRoute: "route" }));
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) => {
        prepared();
        await wait;
        return input.dispatch(initiate);
      });
      const pending = f.service.audio(f.headers, "request", audio());
      await preparation;
      await f.service.browserControl(f.browser, meetingId, command(operation, 1));
      release();
      if (operation === "revoke") await expect(pending).rejects.toThrow();
      else expect(await pending).toMatchObject({ status: "failed" });
      expect(initiate).not.toHaveBeenCalled();
      expect(f.ingest).not.toHaveBeenCalled();
    }
  );
  it("rechecks auth binding after waiting for the final dispatch lock", async () => {
    const f = fixture();
    let release!: () => void;
    let blocked!: () => void;
    let calls = 0,
      revoked = false;
    const waiting = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.lockMeeting).mockImplementation(async () => {
      calls++;
      if (calls === 2) {
        blocked();
        await gate;
      }
    });
    vi.mocked(f.deps.assertBinding).mockImplementation(async () => {
      if (revoked) throw Object.assign(Error("deleted during lock wait"), { httpStatus: 403 });
    });
    const initiate = vi.fn(async () => ({ segments: [], modelRoute: "route" }));
    vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) =>
      input.dispatch(initiate)
    );
    const pending = f.service.audio(f.headers, "request", audio());
    await waiting;
    revoked = true;
    release();
    await expect(pending).rejects.toThrow();
    expect(initiate).not.toHaveBeenCalled();
    expect(f.ingest).not.toHaveBeenCalled();
  });
  it.each(["saved", "failed"] as const)(
    "rechecks auth binding after the final %s result lock wait",
    async (outcome) => {
      const f = fixture();
      let release!: () => void;
      let blocked!: () => void;
      let locks = 0;
      let revoked = false;
      const waiting = new Promise<void>((resolve) => {
        blocked = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      vi.mocked(f.repository.lockMeeting).mockImplementation(async () => {
        locks += 1;
        if (locks === 3) {
          blocked();
          await gate;
        }
      });
      vi.mocked(f.deps.assertBinding).mockImplementation(async () => {
        if (revoked)
          throw Object.assign(Error("deleted during final result lock wait"), { httpStatus: 403 });
      });
      vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) =>
        input.dispatch(async () => {
          if (outcome === "failed") throw Error("synthetic provider failure");
          return {
            segments: [{ startMs: 0, endMs: 900, text: "private synthetic result" }],
            modelRoute: "route"
          };
        })
      );
      const pending = f.service.audio(f.headers, "request", audio());
      await waiting;
      revoked = true;
      release();
      await expect(pending).rejects.toThrow();
      expect(f.ingest).not.toHaveBeenCalled();
      expect(f.repository.finish).not.toHaveBeenCalled();
    }
  );
  it("rechecks session authorization after the asynchronous provider finishes", async () => {
    const f = fixture();
    vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, input) =>
      input.dispatch(async () => {
        vi.mocked(f.deps.assertBinding).mockRejectedValue(
          Object.assign(Error("revoked"), { httpStatus: 403 })
        );
        return { segments: [{ startMs: 0, endMs: 500, text: "private" }], modelRoute: "route" };
      })
    );
    await expect(f.service.audio(f.headers, "request", audio())).rejects.toThrow();
    expect(f.ingest).not.toHaveBeenCalled();
  });
  it("rejects wrong grant/device binding rather than selecting latest active device", async () => {
    const f = fixture();
    await expect(
      f.service.browserControl(f.browser, meetingId, {
        ...command("record", 0),
        grantId: randomUUID()
      })
    ).rejects.toThrow();
    expect(f.repository.save).not.toHaveBeenCalled();
  });
});

describe("capture processing stays independent", () => {
  it("returns a receipt that expires during processing without adding a conflicting failure gap", async () => {
    const f = fixture();
    const input = audio();
    const expired = {
      requestKey: input.requestKey,
      status: "failed" as const,
      code: "meeting_capture_interrupted",
      reason: "audio-expired",
      stage: "authorization" as const,
      retryable: false
    };
    let processingFailed = false;
    vi.mocked(f.deps.transcribe).mockImplementation(async (_actor, request) =>
      request.dispatch(async () => {
        processingFailed = true;
        throw new Error("Synthetic late provider failure");
      })
    );
    vi.mocked(f.repository.reconcileExpiredAudio).mockImplementation(async (_db, _grant, next) => {
      if (!processingFailed) return;
      f.receipts.get(input.requestKey)!.result_json = JSON.stringify(expired);
      retainCaptureGap(
        next,
        {
          id: input.requestKey,
          sourceId: input.sourceId,
          epoch: input.epoch,
          startMs: input.startMs,
          endMs: input.endMs,
          reason: "interrupted"
        },
        at(2000)
      );
    });
    expect(await f.service.audio(f.headers, "expired-during-processing", input)).toEqual(expired);
    expect(f.ingest).not.toHaveBeenCalled();
    expect(f.repository.finish).not.toHaveBeenCalled();
  });
  it("retries a transient same-key clip without pausing capture or inventing a gap", async () => {
    const f = fixture(),
      clip = audio();
    vi.mocked(f.deps.transcribe).mockRejectedValueOnce(new Error("synthetic transport outage"));
    Object.assign(f.deps, {
      describeProcessingFailure: () => ({
        code: "meeting_capture_processing_failed",
        reason: "provider-network",
        stage: "dispatch",
        retryable: true,
        retryAfterMs: 1000
      })
    });
    vi.spyOn(f.repository, "retry").mockImplementation(async (_db, _grant, receipt) => {
      receipt.result_json = null;
      return true;
    });
    const delayed = await f.service.audio(f.headers, "delay", clip);
    expect(delayed).toMatchObject({
      status: "failed",
      reason: "provider-network",
      retryable: true
    });
    expect(JSON.parse(f.grant.state_json!)).toMatchObject({
      desired: "recording",
      gaps: [],
      processing: { status: "delayed" }
    });
    expect(await f.service.audio(f.headers, "retry", clip)).toMatchObject({ status: "saved" });
    expect(f.deps.transcribe).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.grant.state_json!)).toMatchObject({
      desired: "recording",
      gaps: [],
      processing: { status: "ready" },
      transcriptRevision: 1
    });
  });
  it("labels transcript persistence separately and does not expose thrown private data", async () => {
    const f = fixture();
    f.ingest.mockRejectedValueOnce(new Error("private transcript provider secret"));
    const receipt = await f.service.audio(f.headers, "persistence", audio());
    expect(receipt).toMatchObject({
      status: "failed",
      reason: "transcript-persistence",
      stage: "persistence",
      retryable: true
    });
    expect(JSON.stringify([...f.receipts.values()])).not.toContain(
      "private transcript provider secret"
    );
    expect(JSON.parse(f.grant.state_json!).desired).toBe("recording");
  });
  it("classifies a transcript version conflict as retryable persistence rather than revoked capture", async () => {
    const f = fixture();
    f.ingest.mockResolvedValueOnce({
      status: "conflict",
      receipt: { version: 1, cursor: 1, transcriptRevision: 1, stopCutoffMs: null }
    });
    expect(await f.service.audio(f.headers, "conflict", audio())).toMatchObject({
      status: "failed",
      reason: "transcript-conflict",
      stage: "persistence",
      retryable: true,
      retryAfterMs: 250
    });
    expect(JSON.parse(f.grant.state_json!).desired).toBe("recording");
  });
  it("replays a committed Resume after processing readiness becomes unavailable", async () => {
    const f = fixture();
    await f.service.browserControl(f.browser, meetingId, command("pause", 1));
    const resume = { ...command("record", 2), selection: undefined };
    const resumed = await f.service.browserControl(f.browser, meetingId, resume);
    vi.mocked(f.deps.processingAvailability).mockRejectedValue(
      new Error("synthetic unavailable route")
    );
    expect(await f.service.browserControl(f.browser, meetingId, resume)).toEqual(resumed);
    expect(JSON.parse(f.grant.state_json!).generation).toBe(3);
  });
  it("does not misreport a transient auth storage outage as revocation", async () => {
    const f = fixture();
    vi.mocked(f.deps.assertBinding).mockRejectedValue(
      new Error("synthetic auth storage unavailable")
    );
    await expect(f.service.audio(f.headers, "outage", audio())).rejects.toMatchObject({
      httpStatus: 503
    });
    expect(f.deps.transcribe).not.toHaveBeenCalled();
    expect(JSON.parse(f.grant.state_json!).desired).toBe("recording");
  });
  it("reads unchanged browser state without repeatedly rewriting it", async () => {
    const f = fixture();
    vi.spyOn(f.repository, "grants").mockResolvedValue([f.grant]);
    await f.service.browserStatus(f.browser, meetingId);
    vi.mocked(f.repository.save).mockClear();
    const first = await f.service.browserStatus(f.browser, meetingId),
      second = await f.service.browserStatus(f.browser, meetingId);
    expect(second.revision).toBe(first.revision);
    expect(f.repository.save).not.toHaveBeenCalled();
  });
});
