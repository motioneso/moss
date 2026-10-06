import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MeetingCaptureInventory, MeetingCaptureStartInput } from "@moss/shared";
import { MeetingCaptureConnectionService } from "../../packages/meetings/src/capture-connection-service.js";
import {
  MeetingCaptureConnectionRepository,
  type CaptureConnection
} from "../../packages/meetings/src/capture-connection-repository.js";
import {
  MeetingCaptureRepository,
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
  const service = new MeetingCaptureConnectionService(deps, grants, connections);
  const start: MeetingCaptureStartInput = {
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
    start,
    headers,
    claim,
    get grant() {
      return grant;
    },
    setClock: (at: Date) => (clock = at)
  };
}
describe("shared connection explicit Start and native claim", () => {
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
        selection: { mode: "microphone-only", microphone: f.start.selection.microphone }
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
  it("binds current readiness and stable app identity without broadening sources", async () => {
    for (const change of [
      { expectedRevision: 2 },
      { selection: { ...fixture().start.selection, applicationId: "com.other.app" } }
    ]) {
      const f = fixture();
      await expect(
        f.service.start(f.browser, meetingId, { ...f.start, ...change })
      ).rejects.toThrow();
      expect(f.connections.create).not.toHaveBeenCalled();
    }
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
