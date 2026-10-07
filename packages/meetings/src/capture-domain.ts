import { createHash, randomUUID } from "node:crypto";
import type {
  MeetingCaptureGap,
  MeetingCaptureRevocationReason,
  MeetingCaptureAudioInput,
  MeetingCaptureControlInput,
  MeetingCaptureInventory,
  MeetingCaptureState,
  MeetingCaptureSelection,
  MeetingCaptureProcessingState
} from "@moss/shared";
import {
  MEETING_CAPTURE_MAX_AUDIO_BYTES,
  MEETING_CAPTURE_MAX_CLIP_MS,
  MEETING_CAPTURE_FINALIZATION_MS,
  MEETING_CAPTURE_LEASE_MS
} from "@moss/shared";

export class MeetingCaptureError extends Error {
  constructor(
    readonly code = "meeting_capture_unavailable",
    readonly httpStatus = 401,
    readonly retryAfterSeconds = 1,
    readonly revocationReason?: MeetingCaptureRevocationReason
  ) {
    super(code);
  }
}
export interface CaptureEpoch {
  epoch: number;
  generation: number;
  startMs: number;
  endMs: number | null;
  selection: MeetingCaptureSelection;
  microphoneLabel: string;
  outputLabel: string | null;
  modelRoute: string;
}
export interface CaptureStoredState {
  maintenanceSequence?: number;
  revocationReason?: MeetingCaptureRevocationReason;
  gaps: MeetingCaptureGap[];
  gapLimitReached: boolean;
  generation: number;
  desired: MeetingCaptureState["desired"];
  originAt: string;
  epochs: CaptureEpoch[];
  stopCutoffMs: number | null;
  finalizationDeadline: string | null;
  inventory: MeetingCaptureInventory | null;
  observed: MeetingCaptureState["observed"];
  lastSeenAt: string | null;
  recordedDurationMs?: number;
  transcriptRevision?: number;
  finalized?: boolean;
  processing?: MeetingCaptureProcessingState;
}
export function elapsed(state: CaptureStoredState, at: Date): number {
  return Math.max(0, at.getTime() - Date.parse(state.originAt));
}
export function expireCaptureLease(state: CaptureStoredState, at: Date, expiresAt?: Date): void {
  if (
    state.desired === "recording" &&
    (!state.lastSeenAt || at.getTime() - Date.parse(state.lastSeenAt) > MEETING_CAPTURE_LEASE_MS)
  ) {
    const leaseEnd = new Date(
      Math.min(
        at.getTime(),
        Date.parse(state.lastSeenAt ?? state.originAt) + MEETING_CAPTURE_LEASE_MS,
        expiresAt?.getTime() ?? Date.parse(state.originAt) + 7200000
      )
    );
    const epoch = state.epochs.at(-1);
    if (epoch) {
      const startMs = Math.max(
        epoch.startMs,
        state.lastSeenAt ? Date.parse(state.lastSeenAt) - Date.parse(state.originAt) : epoch.startMs
      );
      const endMs = elapsed(state, leaseEnd);
      if (endMs > startMs) {
        const sources = [
          epoch.selection.microphone.sourceId,
          ...(epoch.selection.mode === "microphone-only" ? [] : [epoch.selection.outputSourceId])
        ];
        for (const sourceId of sources)
          retainCaptureGap(
            state,
            {
              id: randomUUID(),
              sourceId,
              epoch: epoch.epoch,
              startMs,
              endMs,
              reason: "interrupted"
            },
            leaseEnd
          );
      }
    }
    if (epoch && epoch.endMs === null) epoch.endMs = elapsed(state, leaseEnd);
    state.desired = "paused";
    state.generation += 1;
    state.observed = {
      generation: state.generation,
      phase: "error",
      errorCode: "meeting_capture_interrupted"
    };
  }
}
function invalid(): never {
  throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
}
export function validateCaptureSelection(
  selection: MeetingCaptureSelection,
  inventory: MeetingCaptureInventory
): void {
  if (
    !selection ||
    !inventory.microphones.some(
      (mic) =>
        mic.deviceId === selection.microphone?.deviceId &&
        mic.sourceId === selection.microphone?.sourceId
    ) ||
    inventory.microphonePermission === "denied"
  )
    invalid();
  if (selection.mode === "microphone-only") return;
  if (
    !selection.outputSourceId ||
    selection.outputSourceId === selection.microphone.sourceId ||
    inventory.systemAudioPermission === "denied"
  )
    invalid();
  if (selection.mode === "selected-app") {
    if (
      !inventory.applications.some(
        (app) =>
          app.appProcessTreeId === selection.appProcessTreeId &&
          (!selection.applicationId || app.applicationId === selection.applicationId)
      )
    )
      invalid();
  } else if (selection.mode === "computer-audio") {
    if (
      !inventory.computerAudio.available ||
      selection.scope.kind !== "process-exclusion" ||
      !selection.scope.excludedProcessTreeIds.length ||
      JSON.stringify([...selection.scope.excludedProcessTreeIds].sort()) !==
        JSON.stringify([...inventory.computerAudio.excludedProcessTreeIds].sort())
    )
      invalid();
  } else invalid();
}
export function applyCaptureControl(
  state: CaptureStoredState,
  input: MeetingCaptureControlInput,
  at: Date,
  modelRoute = ""
): void {
  if (input.expectedGeneration !== state.generation)
    throw new MeetingCaptureError("meeting_capture_conflict", 409);
  if (state.desired === "revoked") throw new MeetingCaptureError();
  const current = state.epochs.at(-1);
  const atMs = elapsed(state, at);
  if (input.command === "record") {
    if (state.gapLimitReached) throw new MeetingCaptureError("meeting_capture_limit", 413);
    if (!["idle", "paused"].includes(state.desired) || !input.selection || !state.inventory)
      invalid();
    if (!state.lastSeenAt || at.getTime() - Date.parse(state.lastSeenAt) > MEETING_CAPTURE_LEASE_MS)
      throw new MeetingCaptureError("meeting_capture_interrupted", 409);
    if (state.epochs.length >= 64) throw new MeetingCaptureError("meeting_capture_limit", 413);
    validateCaptureSelection(input.selection, state.inventory);
    state.epochs.push({
      modelRoute,
      epoch: state.epochs.length + 1,
      generation: state.generation + 1,
      startMs: atMs,
      endMs: null,
      selection: input.selection,
      microphoneLabel: state.inventory.microphones.find(
        (m) => m.deviceId === input.selection!.microphone.deviceId
      )!.label,
      outputLabel:
        input.selection.mode === "selected-app"
          ? state.inventory.applications.find(
              (a) =>
                a.appProcessTreeId ===
                (input.selection as Extract<MeetingCaptureSelection, { mode: "selected-app" }>)
                  .appProcessTreeId
            )!.label
          : input.selection.mode === "computer-audio"
            ? "Computer audio"
            : null
    });
    state.desired = "recording";
  } else if (input.command === "pause") {
    if (state.desired !== "recording") invalid();
    if (current) current.endMs = atMs;
    state.desired = "paused";
  } else if (input.command === "stop") {
    if (state.desired === "stopped") return;
    if (current?.endMs === null) current.endMs = atMs;
    state.stopCutoffMs = atMs;
    state.finalizationDeadline = new Date(
      at.getTime() + MEETING_CAPTURE_FINALIZATION_MS
    ).toISOString();
    state.desired = "stopped";
  } else if (input.command === "revoke") {
    if (current?.endMs === null) current.endMs = atMs;
    state.desired = "revoked";
  } else invalid();
  state.generation += 1;
}
export function decodeCaptureAudio(input: MeetingCaptureAudioInput): {
  pcm: Buffer;
  fingerprint: string;
} {
  if (
    !Number.isInteger(input.sampleRateHz) ||
    input.sampleRateHz < 8000 ||
    input.sampleRateHz > 192000 ||
    ![input.startMs, input.endMs, input.sequence, input.epoch, input.generation].every(
      Number.isSafeInteger
    ) ||
    input.startMs < 0 ||
    input.sequence < 0 ||
    input.epoch < 1 ||
    input.generation < 1 ||
    input.endMs <= input.startMs ||
    input.endMs - input.startMs > MEETING_CAPTURE_MAX_CLIP_MS ||
    typeof input.pcmBase64 !== "string" ||
    input.pcmBase64.length > Math.ceil(MEETING_CAPTURE_MAX_AUDIO_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(input.pcmBase64) ||
    input.pcmBase64.length % 4 !== 0
  )
    invalid();
  const pcm = Buffer.from(input.pcmBase64, "base64");
  if (
    pcm.toString("base64") !== input.pcmBase64 ||
    !pcm.length ||
    pcm.length % 2 ||
    pcm.length > MEETING_CAPTURE_MAX_AUDIO_BYTES ||
    Math.abs((pcm.length / 2 / input.sampleRateHz) * 1000 - (input.endMs - input.startMs)) > 2
  )
    invalid();
  const metadata = {
    meetingId: input.meetingId,
    grantId: input.grantId,
    generation: input.generation,
    epoch: input.epoch,
    sourceId: input.sourceId,
    sequence: input.sequence,
    startMs: input.startMs,
    endMs: input.endMs,
    sampleRateHz: input.sampleRateHz
  };
  return {
    pcm,
    fingerprint: createHash("sha256").update(JSON.stringify(metadata)).update(pcm).digest("hex")
  };
}
export function assertCaptureAudioAdmission(
  state: CaptureStoredState,
  input: MeetingCaptureAudioInput,
  at: Date
): CaptureEpoch {
  const epoch = state.epochs.find(
    (entry) => entry.epoch === input.epoch && entry.generation === input.generation
  );
  if (
    !epoch ||
    input.startMs < epoch.startMs ||
    input.endMs > elapsed(state, at) ||
    elapsed(state, at) - input.endMs > MEETING_CAPTURE_FINALIZATION_MS
  )
    throw new MeetingCaptureError("meeting_capture_conflict", 409);
  if (
    input.sourceId !== epoch.selection.microphone.sourceId &&
    (epoch.selection.mode === "microphone-only" ||
      input.sourceId !== epoch.selection.outputSourceId)
  )
    invalid();
  const finalFlush =
    state.desired === "stopped" &&
    !state.finalized &&
    state.finalizationDeadline !== null &&
    at.getTime() <= Date.parse(state.finalizationDeadline) &&
    state.observed?.phase === "stopped" &&
    state.observed.generation === state.generation;
  const resumedFlush =
    epoch.endMs !== null &&
    epoch !== state.epochs.at(-1) &&
    state.desired === "recording" &&
    state.observed?.phase === "recording" &&
    state.observed.generation === state.generation;
  if (
    !finalFlush &&
    (state.desired !== "recording" ||
      (!resumedFlush && state.generation !== input.generation) ||
      state.observed?.phase !== "recording" ||
      (!resumedFlush && state.observed.generation !== input.generation) ||
      !state.lastSeenAt ||
      at.getTime() - Date.parse(state.lastSeenAt) > MEETING_CAPTURE_LEASE_MS)
  )
    throw new MeetingCaptureError("meeting_capture_interrupted", 409);
  if (
    (epoch.endMs !== null && input.endMs > epoch.endMs) ||
    (state.stopCutoffMs !== null && input.endMs > state.stopCutoffMs)
  )
    throw new MeetingCaptureError("meeting_capture_conflict", 409);
  return epoch;
}
export function pcmWave(pcm: Uint8Array, sampleRateHz: number): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRateHz, 24);
  header.writeUInt32LE(sampleRateHz * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Retain bounded metadata, making exhaustion visible and closing recording admission. */
export function retainCaptureGap(
  state: CaptureStoredState,
  gap: MeetingCaptureGap,
  at: Date
): void {
  const epoch = state.epochs.find((entry) => entry.epoch === gap.epoch);
  if (
    !epoch ||
    ![gap.startMs, gap.endMs].every(Number.isSafeInteger) ||
    gap.startMs < epoch.startMs ||
    gap.endMs <= gap.startMs ||
    gap.endMs > elapsed(state, at) ||
    (state.stopCutoffMs !== null && gap.endMs > state.stopCutoffMs) ||
    (gap.sourceId !== epoch.selection.microphone.sourceId &&
      (epoch.selection.mode === "microphone-only" ||
        gap.sourceId !== epoch.selection.outputSourceId))
  )
    throw new MeetingCaptureError("meeting_capture_invalid_input", 400);
  const prior = state.gaps.find((entry) => entry.id === gap.id);
  if (prior) {
    if (
      prior.sourceId !== gap.sourceId ||
      prior.epoch !== gap.epoch ||
      prior.startMs !== gap.startMs ||
      prior.endMs !== gap.endMs ||
      prior.reason !== gap.reason
    )
      throw new MeetingCaptureError("meeting_capture_conflict", 409);
    return;
  }
  if (state.gaps.length >= 256) {
    state.gapLimitReached = true;
    if (state.desired === "recording") {
      const current = state.epochs.at(-1)!;
      current.endMs = elapsed(state, at);
      state.desired = "paused";
      state.generation += 1;
    }
    state.observed = {
      generation: state.generation,
      phase: "error",
      errorCode: "meeting_capture_limit"
    };
    return;
  }
  state.gaps.push(gap);
}
