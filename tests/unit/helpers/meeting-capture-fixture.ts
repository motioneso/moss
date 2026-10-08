import { createHash, randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import type { DataContextDb } from "@moss/db";
import type {
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureInventory,
  MeetingCaptureSelection
} from "@moss/shared";
import {
  applyCaptureControl,
  MeetingCaptureError,
  type CaptureStoredState
} from "../../../packages/meetings/src/capture-domain.js";
import {
  MeetingCaptureRepository,
  type CaptureGrant,
  type CaptureReceipt
} from "../../../packages/meetings/src/capture-repository.js";
import {
  MeetingCaptureService,
  type MeetingCaptureDependencies
} from "../../../packages/meetings/src/capture-service.js";
import { MeetingCaptureConnectionRepository } from "../../../packages/meetings/src/capture-connection-repository.js";
import { MeetingTranscriptRepository } from "../../../packages/meetings/src/transcript-repository.js";
import { MeetingPreferencesRepository } from "../../../packages/meetings/src/preferences.js";
export const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const meetingId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const grantId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
export const deviceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const origin = new Date("2026-10-05T00:00:00Z");
export const at = (ms: number) => new Date(origin.getTime() + ms);
export const inventory: MeetingCaptureInventory = {
  microphones: [{ deviceId: "mic-device", sourceId: "mic", label: "Selected microphone" }],
  applications: [{ appProcessTreeId: "selected-app", label: "Selected app" }],
  computerAudio: { available: true, excludedProcessTreeIds: ["moss"] },
  microphonePermission: "granted",
  systemAudioPermission: "granted"
};
export function state(): CaptureStoredState {
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
export function command(
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
export function recording(selection = command("record", 0).selection) {
  const value = state();
  applyCaptureControl(value, { ...command("record", 0), selection }, origin, "route");
  value.observed = { generation: 1, phase: "recording" };
  value.lastSeenAt = at(2000).toISOString();
  return value;
}
export function audio(): MeetingCaptureAudioInput {
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
    // Non-silent PCM16 signal: ordinary fixture calls exercise real provider dispatch.
    pcmBase64: Buffer.alloc(32000, Buffer.from([0, 1, 0, 255])).toString("base64")
  };
}
export function fixture(selection?: MeetingCaptureSelection, now: () => Date = () => at(2000)) {
  let active = 0;
  const value = recording(selection);
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
  const grantRows = [grant];
  const actors = new WeakMap<DataContextDb, string>();
  const receipts = new Map<string, CaptureReceipt>();
  const receiptRows = new Map([[grantId, receipts]]);
  const receiptsFor = (id: string) => {
    let rows = receiptRows.get(id);
    if (!rows) {
      rows = new Map();
      receiptRows.set(id, rows);
    }
    return rows;
  };
  vi.spyOn(repository, "reconcileExpiredAudio").mockResolvedValue();
  vi.spyOn(repository, "hasPendingAudio").mockResolvedValue(false);
  vi.spyOn(repository, "lockMeeting").mockResolvedValue();
  // Model the repository's owner-scoped lookup; these unit doubles do not exercise SQL RLS.
  vi.spyOn(repository, "grant").mockImplementation(
    async (db, id) =>
      grantRows.find((row) => row.id === id && row.owner_user_id === actors.get(db)) ?? null
  );
  vi.spyOn(repository, "save").mockImplementation(async (db, saved, next) => {
    const row = grantRows.find(
      (candidate) => candidate.id === saved.id && candidate.owner_user_id === actors.get(db)
    );
    expect(row).toBeDefined();
    row!.state_json = JSON.stringify(next);
    saved.state_json = row!.state_json;
    if (next.desired === "revoked") row!.status = saved.status = "revoked";
  });
  vi.spyOn(repository, "receipt").mockImplementation(async (_db, id, key, fingerprint) => {
    const row = receiptsFor(id).get(key);
    if (row && row.fingerprint !== fingerprint)
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    return row ?? null;
  });
  vi.spyOn(repository, "reserve").mockImplementation(async (_db, id, input) => {
    receiptsFor(id).set(input.requestKey, {
      request_key: input.requestKey,
      kind: input.kind,
      fingerprint: input.fingerprint,
      metadata_json: JSON.stringify(input.metadata),
      result_json: input.result ? JSON.stringify(input.result) : null,
      created_at: at(2000)
    });
  });
  vi.spyOn(repository, "admitAudio").mockImplementation(async (db, admitted, input, fingerprint) =>
    repository.reserve(db, admitted.id, {
      requestKey: input.requestKey,
      kind: "audio",
      fingerprint,
      metadata: {}
    })
  );
  vi.spyOn(repository, "finish").mockImplementation(async (_db, id, result) => {
    const receipt = receiptsFor(id).get(result.requestKey);
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
      withDataContext: async (actor, run) => {
        active++;
        const db = {} as Parameters<typeof run>[0];
        actors.set(db, actor.actorUserId);
        try {
          return await run(db);
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
    now
  };
  const connections = new MeetingCaptureConnectionRepository();
  vi.spyOn(connections, "lock").mockResolvedValue();
  const connection = {
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
  };
  const connectionRows = [connection];
  vi.spyOn(connections, "connection").mockImplementation(
    async (db, id) =>
      connectionRows.find((row) => row.device_id === id && row.owner_user_id === actors.get(db)) ??
      null
  );
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
    connection,
    connectionRows,
    connections,
    grant,
    grantRows,
    ingest,
    transcript,
    repository,
    receipts,
    receiptsFor,
    headers: { authorization: `Bearer ${credential}` },
    browser: { actorUserId: owner, sessionId: grant.session_id!, expiresAt: grant.expires_at }
  };
}

export function addRecording(
  f: ReturnType<typeof fixture>,
  identity: Partial<Pick<CaptureGrant, "id" | "meeting_id" | "owner_user_id" | "device_id">> = {}
) {
  const grant = {
    ...f.grant,
    id: randomUUID(),
    meeting_id: randomUUID(),
    device_id: randomUUID(),
    session_id: randomUUID(),
    connection_id: randomUUID(),
    ...identity
  };
  const credential = `mm1_${grant.owner_user_id}.${grant.id}.${"t".repeat(43)}`;
  grant.credential_hash = createHash("sha256").update(credential).digest("hex");
  const connection = {
    ...f.connection,
    owner_user_id: grant.owner_user_id,
    device_id: grant.device_id,
    connection_id: grant.connection_id
  };
  f.grantRows.push(grant);
  f.connectionRows.push(connection);
  return { grant, connection, headers: { authorization: `Bearer ${credential}` } };
}
