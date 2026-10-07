import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import { captureMetadataJson } from "../../packages/meetings/src/capture-metadata.js";
import { assertCaptureAudioAdmission } from "../../packages/meetings/src/capture-domain.js";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureInventory, MeetingCaptureLegacyStartInput } from "@moss/shared";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
import {
  MeetingCaptureConnectionRepository,
  type CaptureConnection
} from "../../packages/meetings/src/capture-connection-repository.js";
import {
  MeetingCaptureRepository,
  captureState,
  type CaptureGrant
} from "../../packages/meetings/src/capture-repository.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../packages/meetings/src/capture-service.js";
const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  deviceId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  connectionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  meetingId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  requestKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const now = new Date("2026-10-06T00:00:00Z");
const later = new Date(now.getTime() + 7200000);
const verifier = "v".repeat(43);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inventory: MeetingCaptureInventory = {
  microphones: [{ deviceId: "mic-uid", sourceId: "mic", label: "Microphone" }],
  applications: [
    { applicationId: "com.example.meeting", appProcessTreeId: "123", label: "Meeting app" }
  ],
  computerAudio: { available: true, excludedProcessTreeIds: ["moss"] },
  microphonePermission: "unknown",
  systemAudioPermission: "granted"
};
function fixture() {
  let clock = now;
  const actor = {
    actorUserId: owner,
    deviceId,
    capabilityRevision: 1,
    expiresAt: later,
    requestId: "native"
  };
  const browser = {
    actorUserId: owner,
    sessionId: requestKey,
    expiresAt: later,
    requestId: "browser"
  };
  const connection: CaptureConnection = {
    owner_user_id: owner,
    device_id: deviceId,
    connection_id: connectionId,
    device_name: "Mac",
    verifier_hash: hash(verifier),
    capability_revision: 1,
    revision: 1,
    inventory_json: JSON.stringify(inventory),
    last_seen_at: now,
    expires_at: later
  };
  const grants = new MeetingCaptureRepository(),
    connections = new MeetingCaptureConnectionRepository();
  let grant: CaptureGrant | null = null;
  const deps: MeetingCaptureDependencies = {
    dataContext: { withDataContext: async (_actor, run) => run({} as Parameters<typeof run>[0]) },
    resolveBrowser: vi.fn(async () => browser),
    resolveCompanion: vi.fn(),
    resolveRecording: vi.fn(async () => actor),
    assertRecordingBinding: vi.fn(async () => ({ expiresAt: later })),
    assertBinding: vi.fn(),
    device: vi.fn(async () => ({ displayName: "Mac", expiresAt: later })),
    assertModuleAvailable: vi.fn(),
    processingAvailability: vi.fn(async () => ({ ready: true, modelRoute: "route" })),
    transcribe: vi.fn(),
    trustedOrigins: ["https://moss.example"],
    now: () => clock
  };
  vi.spyOn(connections, "lock").mockResolvedValue();
  vi.spyOn(connections, "connections").mockResolvedValue([connection]);
  vi.spyOn(connections, "cancelled").mockResolvedValue(false);
  vi.spyOn(grants, "lockMeeting").mockResolvedValue();
  vi.spyOn(grants, "transcriptHead").mockResolvedValue({
    version: 0,
    cursor: 0,
    transcript_revision: 0,
    stop_cutoff_ms: null
  });
  vi.spyOn(connections, "connection").mockImplementation(async () => connection);
  vi.spyOn(connections, "register").mockImplementation(async () => connection);
  vi.spyOn(connections, "byRequest").mockImplementation(async (_db, key) =>
    grant?.start_request_key === key ? grant : null
  );
  vi.spyOn(connections, "retire").mockResolvedValue();
  vi.spyOn(connections, "occupied").mockImplementation(
    async () => !!grant && ["approved", "active", "finalizing"].includes(grant.status)
  );
  vi.spyOn(grants, "grants").mockImplementation(async () => (grant ? [grant] : []));
  vi.spyOn(grants, "grant").mockImplementation(async () => grant);
  vi.spyOn(connections, "command").mockImplementation(async () =>
    grant?.status === "approved" ? grant : null
  );
  vi.spyOn(connections, "create").mockImplementation(
    async (_db, input) =>
      (grant = {
        id: requestKey,
        meeting_id: input.meetingId,
        owner_user_id: owner,
        device_id: deviceId,
        device_name: "Mac",
        verifier_hash: connection.verifier_hash,
        credential_hash: null,
        session_id: browser.sessionId,
        status: "approved",
        created_at: clock,
        expires_at: input.expiresAt,
        state_json: JSON.stringify(input.state),
        connection_id: connectionId,
        capability_revision: 1,
        claim_expires_at: input.claimExpiresAt,
        start_request_key: input.requestKey,
        start_fingerprint: input.fingerprint
      })
  );
  vi.spyOn(grants, "activate").mockImplementation(async (_db, row, credentialHash, state) => {
    row.credential_hash = credentialHash;
    row.status = "active";
    row.state_json = JSON.stringify(state);
  });
  const preferences = new MeetingPreferencesRepository();
  vi.spyOn(preferences, "get").mockResolvedValue({
    rememberedSource: {
      deviceId,
      microphoneId: "mic-uid",
      applicationId: "com.example.meeting",
      mode: "selected-app"
    },
    defaultCaptureMode: "selected-app",
    summarizeOnStop: true,
    summaryTemplateId: "general"
  });
  vi.spyOn(connections, "lockRequest").mockResolvedValue();
  const service = new MeetingCaptureConnectionService(deps, grants, connections, preferences);
  const legacyStart: MeetingCaptureLegacyStartInput = {
    deviceId,
    connectionId,
    expectedRevision: 1,
    requestKey,
    selection: {
      mode: "selected-app",
      microphone: { deviceId: "mic-uid", sourceId: "mic" },
      outputSourceId: "output",
      appProcessTreeId: "123",
      applicationId: "com.example.meeting"
    }
  };
  const headers = {
    authorization: "Bearer tm1_synthetic",
    "x-moss-recording-proof": "p".repeat(43)
  };
  const claim = {
    connectionId,
    verifier,
    grantId: requestKey,
    credentialHash: hash(`mm1_${owner}.${requestKey}.${"s".repeat(43)}`)
  };
  return {
    service,
    deps,
    grants,
    connections,
    connection,
    actor,
    browser,
    start: { requestKey },
    legacyStart,
    preferences,
    headers,
    claim,
    get grant() {
      return grant;
    },
    setClock: (at: Date) => (clock = at)
  };
}
describe("shared connection explicit Start and native claim", () => {
  it("replays an explicit Start without creating another grant", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    await f.service.start(f.browser, meetingId, f.start);
    expect(f.connections.create).toHaveBeenCalledOnce();
  });
  it.each(["system default", "sole microphone"])(
    "starts fresh with %s and system audio",
    async (kind) => {
      const f = fixture();
      vi.mocked(f.preferences.get).mockResolvedValue({
        rememberedSource: null,
        defaultCaptureMode: "computer-audio",
        summarizeOnStop: true,
        summaryTemplateId: "general"
      });
      f.connection.inventory_json = JSON.stringify({
        ...inventory,
        ...(kind === "system default"
          ? {
              defaultMicrophoneId: "preferred",
              microphones: [
                ...inventory.microphones,
                { deviceId: "preferred", sourceId: "preferred-mic", label: "Default microphone" }
              ]
            }
          : {})
      });
      const result = await f.service.start(f.browser, meetingId, f.start);
      expect(result.capture.selection).toMatchObject({
        mode: "computer-audio",
        microphone: { deviceId: kind === "system default" ? "preferred" : "mic-uid" }
      });
    }
  );
  it.each([
    "multiple microphones",
    "unknown default",
    "missing default",
    "duplicate default",
    "multiple Macs",
    "denied microphone",
    "missing system audio"
  ])("fails closed for fresh %s", async (kind) => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: null,
      defaultCaptureMode: "computer-audio",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    f.connection.inventory_json = JSON.stringify({
      ...inventory,
      ...(kind === "multiple microphones"
        ? {
            microphones: [
              ...inventory.microphones,
              { deviceId: "second", sourceId: "second", label: "Second" }
            ]
          }
        : {}),
      ...(kind === "missing default" ? { defaultMicrophoneId: "missing" } : {}),
      ...(kind === "unknown default" ? { defaultMicrophoneId: null } : {}),
      ...(kind === "duplicate default"
        ? {
            defaultMicrophoneId: "mic-uid",
            microphones: [...inventory.microphones, ...inventory.microphones]
          }
        : {}),
      ...(kind === "denied microphone" ? { microphonePermission: "denied" } : {}),
      ...(kind === "missing system audio"
        ? { computerAudio: { available: false, excludedProcessTreeIds: [] } }
        : {})
    });
    if (kind === "multiple Macs")
      vi.mocked(f.connections.connections).mockResolvedValue([
        f.connection,
        { ...f.connection, device_id: meetingId }
      ]);
    await expect(f.service.start(f.browser, meetingId, f.start)).rejects.toMatchObject({
      code: "meeting_capture_source_unavailable"
    });
    expect(f.connections.create).not.toHaveBeenCalled();
  });
  it("does not infer a sole Mac from a truncated device inventory", async () => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: null,
      defaultCaptureMode: "computer-audio",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    vi.mocked(f.connections.connections).mockResolvedValue(
      Array.from({ length: 32 }, (_, index) => ({
        ...f.connection,
        expires_at: index === 0 ? later : now
      }))
    );
    await expect(f.service.start(f.browser, meetingId, f.start)).rejects.toMatchObject({
      code: "meeting_capture_source_unavailable"
    });
    expect(f.connections.create).not.toHaveBeenCalled();
  });
  it("ignores expired Macs when resolving a fresh default", async () => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: null,
      defaultCaptureMode: "computer-audio",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    vi.mocked(f.connections.connections).mockResolvedValue([
      f.connection,
      { ...f.connection, device_id: meetingId, expires_at: now }
    ]);
    expect((await f.service.start(f.browser, meetingId, f.start)).capture.deviceId).toBe(deviceId);
  });
  it("rechecks fresh Mac ambiguity after asynchronous processing lookup", async () => {
    const f = fixture();
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: null,
      defaultCaptureMode: "computer-audio",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    vi.mocked(f.deps.processingAvailability).mockImplementation(async () => {
      vi.mocked(f.connections.connections).mockResolvedValue([
        f.connection,
        { ...f.connection, device_id: meetingId }
      ]);
      return { ready: true, modelRoute: "route" };
    });
    await expect(f.service.start(f.browser, meetingId, f.start)).rejects.toMatchObject({
      code: "meeting_capture_source_unavailable"
    });
    expect(f.connections.create).not.toHaveBeenCalled();
  });
  it("uses mode-only preferences with the exact remembered microphone", async () => {
    const f = fixture();
    const preferences = await f.preferences.get({} as never);
    vi.mocked(f.preferences.get).mockResolvedValue({
      ...preferences,
      defaultCaptureMode: "microphone-only"
    });
    expect((await f.service.start(f.browser, meetingId, f.start)).capture.selection).toEqual({
      mode: "microphone-only",
      microphone: { deviceId: "mic-uid", sourceId: "mic" }
    });
  });
  it("preserves an exact legacy pending fingerprint but rejects changed retry metadata", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    f.grant!.start_fingerprint = hash(
      captureMetadataJson({ meetingId, sessionId: f.browser.sessionId, ...f.legacyStart })
    );
    expect(await f.service.start(f.browser, meetingId, f.legacyStart)).toMatchObject({
      capture: { grantId: requestKey }
    });
    await expect(f.service.start(f.browser, meetingId, f.start)).rejects.toMatchObject({
      code: "meeting_capture_conflict"
    });
    expect(f.connections.create).toHaveBeenCalledOnce();
  });
  it("registers readiness without creating a Start or touching meeting content", async () => {
    const f = fixture();
    await f.service.register(f.headers, "register", {
      connectionId,
      verifierHash: hash(verifier),
      inventory
    });
    expect(f.connections.create).not.toHaveBeenCalled();
    expect(f.grants.lockMeeting).not.toHaveBeenCalled();
    expect(await f.service.commands(f.headers, "poll", { connectionId, verifier })).toMatchObject({
      command: null
    });
  });
  it("creates exactly one explicit Start, permits identical request retries and rejects changed authority", async () => {
    const f = fixture();
    const first = await f.service.start(f.browser, meetingId, f.start);
    expect(first.capture).toMatchObject({
      desired: "recording",
      recordedDurationMs: 0,
      observed: null
    });
    expect(await f.service.start(f.browser, meetingId, { ...f.start })).toEqual(first);
    expect(f.connections.create).toHaveBeenCalledOnce();
    await expect(
      f.service.start(f.browser, meetingId, {
        ...f.start,
        selection: { mode: "microphone-only", microphone: f.legacyStart.selection.microphone }
      })
    ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
    await expect(
      f.service.start(f.browser, meetingId, { ...f.start, requestKey: meetingId })
    ).rejects.toMatchObject({ code: "meeting_capture_busy" });
  });
  it("returns the original Start after processing availability changes without reissuing authority", async () => {
    const f = fixture();
    const started = await f.service.start(f.browser, meetingId, f.start);
    vi.mocked(f.deps.processingAvailability).mockRejectedValue(
      new Error("synthetic provider outage")
    );
    expect(await f.service.start(f.browser, meetingId, f.start)).toEqual(started);
    expect(f.connections.create).toHaveBeenCalledOnce();
  });
  it.each(["before request", "during availability"])(
    "atomically fences a cancelled Start %s",
    async (moment) => {
      const f = fixture();
      let cancelled = false;
      vi.mocked(f.connections.cancelled).mockImplementation(async () => cancelled);
      vi.spyOn(f.connections, "cancel").mockImplementation(async () => {
        cancelled = true;
      });
      const capture = new MeetingCaptureService(f.deps, f.grants, undefined, f.connections);
      let release!: () => void, entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (moment === "during availability")
        vi.mocked(f.deps.processingAvailability).mockImplementation(async () => {
          entered();
          await gate;
          return { ready: true, modelRoute: "route" };
        });
      const starting =
        moment === "during availability" ? f.service.start(f.browser, meetingId, f.start) : null;
      if (starting) await waiting;
      expect(
        await capture.cancelStart(f.browser, meetingId, { deviceId, connectionId, requestKey })
      ).toEqual({ cancelled: true, capture: null });
      release?.();
      await expect(
        starting ?? f.service.start(f.browser, meetingId, f.start)
      ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
      expect(f.connections.create).not.toHaveBeenCalled();
    }
  );
  it.each([
    "missing microphone",
    "different microphone",
    "missing app",
    "different app",
    "ambiguous app"
  ])("refuses saved-source %s without fallback", async (change) => {
    const f = fixture();
    const latest = {
      ...structuredClone(inventory),
      microphones: [...inventory.microphones],
      applications: [...inventory.applications]
    };
    if (change === "missing microphone") latest.microphones = [];
    if (change === "missing app") latest.applications = [];
    if (change === "different microphone")
      latest.microphones = [
        { deviceId: "other-mic", sourceId: "other-source", label: "Other microphone" }
      ];
    if (change === "different app")
      latest.applications = [
        { applicationId: "com.other.app", appProcessTreeId: "456", label: "Other app" }
      ];
    if (change === "ambiguous app")
      latest.applications = [
        ...latest.applications,
        { applicationId: "com.example.meeting", appProcessTreeId: "456", label: "Other instance" }
      ];
    f.connection.inventory_json = JSON.stringify(latest);
    await expect(f.service.start(f.browser, meetingId, f.start)).rejects.toMatchObject({
      code: "meeting_capture_source_unavailable"
    });
    expect(f.connections.create).not.toHaveBeenCalled();
  });
  it("replays the original selection after saved defaults change", async () => {
    const f = fixture();
    const first = await f.service.start(f.browser, meetingId, f.start);
    vi.mocked(f.preferences.get).mockResolvedValue({
      rememberedSource: { deviceId: meetingId, microphoneId: "other-mic", mode: "microphone-only" },
      defaultCaptureMode: "microphone-only",
      summarizeOnStop: true,
      summaryTemplateId: "general"
    });
    expect(await f.service.start(f.browser, meetingId, f.start)).toEqual(first);
    expect(f.connections.create).toHaveBeenCalledOnce();
  });
  it("keeps the native-created secret off the server result and retries exactly one hash", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    const first = await f.service.claim(f.headers, "claim", f.claim);
    expect(first).not.toHaveProperty("credential");
    expect(first.capture.generation).toBe(1);
    expect(await f.service.claim(f.headers, "retry", f.claim)).toEqual(first);
    expect(f.grants.activate).toHaveBeenCalledOnce();
    await expect(
      f.service.claim(f.headers, "wrong-hash", { ...f.claim, credentialHash: "a".repeat(64) })
    ).rejects.toMatchObject({ code: "meeting_capture_conflict" });
  });
  it("admits the first audio only after the claimed native recorder acknowledges recording", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    await f.service.claim(f.headers, "claim", f.claim);
    const at = new Date(now.getTime() + 2000);
    f.setClock(at);
    const clip = {
      meetingId,
      grantId: requestKey,
      requestKey,
      generation: 1,
      epoch: 1,
      sourceId: "mic",
      sequence: 0,
      startMs: 0,
      endMs: 1000,
      sampleRateHz: 16000,
      pcmBase64: Buffer.alloc(32000, 1).toString("base64")
    };
    expect(captureState(f.grant!).observed).toBeNull();
    expect(() => assertCaptureAudioAdmission(captureState(f.grant!), clip, at)).toThrow(
      "meeting_capture_interrupted"
    );
    vi.spyOn(f.grants, "reconcileExpiredAudio").mockResolvedValue();
    vi.spyOn(f.grants, "save").mockImplementation(async (_db, grant, state) => {
      grant.state_json = JSON.stringify(state);
    });
    await new MeetingCaptureService(f.deps, f.grants, undefined, f.connections).status(
      { authorization: `Bearer mm1_${owner}.${requestKey}.${"s".repeat(43)}` },
      "recording",
      { meetingId, grantId: requestKey, inventory, observed: { generation: 1, phase: "recording" } }
    );
    expect(assertCaptureAudioAdmission(captureState(f.grant!), clip, at).epoch).toBe(1);
  });
  it("cancels fresh claimed state after waiting for the device lock, never a stale approved snapshot", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    const stale = structuredClone(f.grant!);
    f.setClock(new Date(now.getTime() + 2000));
    let current = stale;
    vi.mocked(f.connections.byRequest).mockImplementation(async () => structuredClone(current));
    vi.mocked(f.connections.lock).mockImplementation(async () => {
      const state = JSON.parse(stale.state_json!);
      state.originAt = new Date(now.getTime() + 1500).toISOString();
      state.recordedDurationMs = 250;
      state.transcriptRevision = 7;
      state.observed = { generation: 1, phase: "recording" };
      current = {
        ...stale,
        status: "active",
        credential_hash: "a".repeat(64),
        state_json: JSON.stringify(state)
      };
    });
    vi.spyOn(f.connections, "cancel").mockResolvedValue();
    vi.spyOn(f.grants, "save").mockImplementation(async (_db, grant, state) => {
      if (grant.status === "approved" && !grant.credential_hash && state.desired === "stopped")
        state.finalized = true;
      grant.state_json = JSON.stringify(state);
    });
    const capture = new MeetingCaptureService(f.deps, f.grants, undefined, f.connections);
    const result = await capture.cancelStart(f.browser, meetingId, { requestKey });
    expect(result.capture).toMatchObject({
      desired: "stopped",
      stopCutoffMs: 500,
      finalization: "pending",
      recordedDurationMs: 250,
      transcriptRevision: 7
    });
    expect(vi.mocked(f.grants.save).mock.calls[0]?.[1]).toMatchObject({
      status: "active",
      credential_hash: "a".repeat(64)
    });
  });
  it("preserves a concurrent Stop's immutable cutoff and deadline when cancellation acquires its locks", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    await f.service.claim(f.headers, "claim", f.claim);
    const stale = structuredClone(f.grant!);
    let current = stale;
    f.setClock(new Date(now.getTime() + 2000));
    vi.mocked(f.connections.byRequest).mockImplementation(async () => structuredClone(current));
    const deadline = new Date(now.getTime() + 60750).toISOString();
    vi.mocked(f.connections.lock).mockImplementation(async () => {
      const state = JSON.parse(stale.state_json!);
      state.desired = "stopped";
      state.generation = 2;
      state.stopCutoffMs = 750;
      state.finalizationDeadline = deadline;
      state.epochs[0].endMs = 750;
      state.transcriptRevision = 8;
      current = { ...stale, status: "finalizing", state_json: JSON.stringify(state) };
    });
    vi.spyOn(f.connections, "cancel").mockResolvedValue();
    vi.spyOn(f.grants, "save").mockImplementation(async (_db, grant, state) => {
      grant.state_json = JSON.stringify(state);
    });
    const result = await new MeetingCaptureService(
      f.deps,
      f.grants,
      undefined,
      f.connections
    ).cancelStart(f.browser, meetingId, { requestKey });
    expect(result.capture).toMatchObject({
      desired: "stopped",
      generation: 2,
      stopCutoffMs: 750,
      epochEndMs: 750,
      finalizationDeadline: deadline,
      transcriptRevision: 8
    });
  });
  it("replays terminal cleanup metadata without reactivating stopped authority", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    await f.service.claim(f.headers, "claim", f.claim);
    f.grant!.status = "complete";
    const stopped = JSON.parse(f.grant!.state_json!);
    stopped.desired = "stopped";
    stopped.finalized = true;
    stopped.generation = 2;
    stopped.stopCutoffMs = 0;
    f.grant!.state_json = JSON.stringify(stopped);
    const replay = await f.service.claim(f.headers, "cleanup", f.claim);
    expect(replay.capture).toMatchObject({
      desired: "stopped",
      finalization: "complete",
      generation: 2
    });
    expect(f.grants.activate).toHaveBeenCalledOnce();
    f.grant!.status = "revoked";
    await expect(f.service.claim(f.headers, "revoked", f.claim)).rejects.toThrow();
    expect(f.grants.activate).toHaveBeenCalledOnce();
    f.grant!.status = "complete";
    f.grant!.expires_at = now;
    await expect(f.service.claim(f.headers, "expired", f.claim)).rejects.toThrow();
  });
  it("requires the launch verifier even with the independent capability proof", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    await expect(
      f.service.claim(f.headers, "wrong-verifier", { ...f.claim, verifier: "x".repeat(43) })
    ).rejects.toThrow();
    expect(f.grants.activate).not.toHaveBeenCalled();
  });
  it.each(["connection", "verifier", "capability", "session", "expiry"])(
    "fences %s changes before native claim",
    async (boundary) => {
      const f = fixture();
      await f.service.start(f.browser, meetingId, f.start);
      if (boundary === "connection") f.connection.connection_id = meetingId;
      if (boundary === "verifier") f.connection.verifier_hash = hash("x".repeat(43));
      if (boundary === "capability") f.actor.capabilityRevision = 2;
      if (boundary === "session")
        vi.mocked(f.deps.assertBinding).mockRejectedValue(new Error("revoked"));
      if (boundary === "expiry") f.setClock(new Date(now.getTime() + 60001));
      await expect(f.service.claim(f.headers, boundary, f.claim)).rejects.toThrow();
      expect(f.grants.activate).not.toHaveBeenCalled();
    }
  );
  it("fails closed without independent recording-capability resolution", async () => {
    const f = fixture();
    Object.assign(f.deps, { resolveRecording: undefined });
    await expect(
      f.service.register({ authorization: "Bearer tm1_legacy" }, "legacy", {
        connectionId,
        verifierHash: hash(verifier),
        inventory
      })
    ).rejects.toThrow();
    expect(f.connections.register).not.toHaveBeenCalled();
  });
  it("reapproval cannot revive a grant issued under the previous capability revision", async () => {
    const f = fixture();
    await f.service.start(f.browser, meetingId, f.start);
    f.actor.capabilityRevision = 2;
    f.connection.capability_revision = 2;
    await expect(f.service.claim(f.headers, "reapproved", f.claim)).rejects.toThrow();
    expect(f.grants.activate).not.toHaveBeenCalled();
  });
});
