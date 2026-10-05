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
          noticeAcknowledged: true as const,
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
    expireCaptureLease(value, at(12001));
    expect(value.desired).toBe("paused");
    expect(value.generation).toBe(2);
    expect(() => assertCaptureAudioAdmission(value, audio(), at(13000))).toThrow();
    expect(() => applyCaptureControl(value, command("record", 2), at(13000))).toThrow();
  });
  it("freezes lease cutoff at last contact plus10seconds even on a next-day read", () => {
    const value = recording();
    expireCaptureLease(value, at(86400000));
    expect(value.epochs[0]?.endMs).toBe(12000);
    expect(value.gaps.map((gap) => [gap.startMs, gap.endMs])).toEqual([[2000, 12000]]);
    expireCaptureLease(value, at(172800000));
    expect(value.epochs[0]?.endMs).toBe(12000);
    expect(value.gaps).toHaveLength(1);
    const short = recording();
    expireCaptureLease(short, at(86400000), at(5000));
    expect(short.epochs[0]?.endMs).toBe(5000);
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
    created_at: origin,
    expires_at: at(7200000),
    state_json: JSON.stringify(value)
  };
  const repository = new MeetingCaptureRepository();
  const receipts = new Map<string, CaptureReceipt>();
  vi.spyOn(repository, "reconcileExpiredAudio").mockResolvedValue();
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
  const service = new MeetingCaptureService(deps, repository, transcript);
  return {
    deps,
    service,
    grant,
    ingest,
    repository,
    receipts,
    headers: { authorization: `Bearer ${credential}` },
    browser: { actorUserId: owner, sessionId: grant.session_id!, expiresAt: grant.expires_at }
  };
}
describe("capture service authorization and dispatch", () => {
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
  it.each(["approved link", "approved grant"] as const)(
    "rejects another device of the same owner at the %s even with the correct verifier",
    async (boundary) => {
      const f = fixture();
      const otherDeviceId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
      const verifier = "v".repeat(43);
      f.grant.status = "approved";
      f.grant.verifier_hash = createHash("sha256").update(verifier).digest("hex");
      const link = {
        id: grantId,
        meeting_id: meetingId,
        owner_user_id: owner,
        device_id: boundary === "approved link" ? deviceId : otherDeviceId,
        device_name: "Synthetic approved Mac",
        verifier_hash: f.grant.verifier_hash,
        status: "approved" as const,
        created_at: origin,
        expires_at: at(600000)
      };
      vi.spyOn(f.repository, "link").mockImplementation(async () => link);
      vi.spyOn(f.repository, "grants").mockResolvedValue([]);
      vi.spyOn(f.repository, "revokeExpired").mockResolvedValue();
      const activate = vi.spyOn(f.repository, "activate").mockResolvedValue();
      vi.mocked(f.deps.resolveCompanion).mockResolvedValue({
        actorUserId: owner,
        deviceId: otherDeviceId,
        requestId: "wrong-device"
      });
      const input = { meetingId, challengeId: grantId, verifier };
      await expect(
        f.service.redeem(
          { authorization: "Bearer tm1_synthetic_other_device" },
          "wrong-device",
          input
        )
      ).rejects.toMatchObject({ code: "meeting_capture_unavailable" });
      expect(activate).not.toHaveBeenCalled();
      expect(f.deps.assertBinding).not.toHaveBeenCalled();
      expect(f.repository.grant).toHaveBeenCalledTimes(boundary === "approved link" ? 0 : 1);
      // Positive control: the same owner/verifier can redeem when both stored device scopes match.
      link.device_id = deviceId;
      vi.mocked(f.deps.resolveCompanion).mockResolvedValue({
        actorUserId: owner,
        deviceId,
        requestId: "approved-device"
      });
      expect(
        await f.service.redeem(
          { authorization: "Bearer tm1_synthetic_approved_device" },
          "approved-device",
          input
        )
      ).toMatchObject({ status: "issued", grantId });
      expect(activate).toHaveBeenCalledOnce();
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
      if (revoked) throw Error("deleted during lock wait");
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
        if (revoked) throw Error("deleted during final result lock wait");
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
        vi.mocked(f.deps.assertBinding).mockRejectedValue(Error("revoked"));
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
