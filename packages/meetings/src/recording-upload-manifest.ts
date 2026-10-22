import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import type { MeetingRecordingUploadManifest } from "@moss/shared";
import { RecordingImportInputError } from "./recording-validation-error.js";
import {
  RECORDING_SOURCE_LIMITS,
  type RecordingSourceKind
} from "./recording-source-validation.js";

export const recordingSourceKinds = ["packets", "sidecar", "wav"] as const;
export const recordingChunkPath = (id: string, kind: RecordingSourceKind, index: number) =>
  `meeting-recordings/${id}/${kind}/${index}.bin`;
export const recordingHash = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(): never {
  throw new RecordingImportInputError();
}
function object(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== keys.length || keys.some((key) => !(key in obj))) invalid();
  return obj;
}
export function parseRecordingUpload(value: unknown) {
  const input = object(value, [
    "version",
    "sourceDeviceId",
    "recordingId",
    "destination",
    ...recordingSourceKinds
  ]);
  if (
    input.version !== 3 ||
    typeof input.sourceDeviceId !== "string" ||
    !isUuid(input.sourceDeviceId) ||
    typeof input.recordingId !== "string" ||
    !/^(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}$/.test(input.recordingId)
  )
    invalid();
  const raw = input.destination as Record<string, unknown> | null;
  const destination = object(
    raw,
    raw?.intent === "meeting" ? ["intent"] : ["intent", "enablementId", "capturedAt"]
  );
  let target: MeetingRecordingUploadManifest["destination"];
  if (destination.intent === "meeting") target = { intent: "meeting" };
  else {
    if (
      destination.intent !== "voice-request" ||
      !input.recordingId.startsWith("amsg_") ||
      typeof destination.enablementId !== "string" ||
      !isUuid(destination.enablementId) ||
      (destination.capturedAt !== null &&
        (typeof destination.capturedAt !== "string" ||
          !Number.isFinite(Date.parse(destination.capturedAt)) ||
          new Date(destination.capturedAt).toISOString() !== destination.capturedAt))
    )
      invalid();
    target = {
      intent: "voice-request",
      enablementId: destination.enablementId.toLowerCase(),
      capturedAt: destination.capturedAt as string | null
    };
  }
  function file(kind: RecordingSourceKind) {
    const f = object(input[kind], ["byteLength", "sha256"]);
    if (
      typeof f.byteLength !== "number" ||
      !Number.isSafeInteger(f.byteLength) ||
      f.byteLength < 1 ||
      typeof f.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(f.sha256)
    )
      invalid();
    if (f.byteLength > RECORDING_SOURCE_LIMITS[kind]) throw new RecordingImportInputError(413);
    return { byteLength: f.byteLength, sha256: f.sha256 };
  }
  const manifest: MeetingRecordingUploadManifest = {
    version: 3,
    sourceDeviceId: input.sourceDeviceId.toLowerCase(),
    recordingId: input.recordingId,
    destination: target,
    packets: file("packets"),
    sidecar: file("sidecar"),
    wav: file("wav")
  };
  const durationMs = (manifest.wav.byteLength - 44) / 32;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0) invalid();
  if (durationMs > (target.intent === "meeting" ? RECORDING_SOURCE_LIMITS.durationMs : 120_000))
    throw new RecordingImportInputError(413);
  const canonical = JSON.stringify(manifest);
  return {
    manifest,
    canonical,
    fingerprint: recordingHash(canonical),
    durationMs,
    mode: input.recordingId.startsWith("amsg_") ? ("voice-request" as const) : ("normal" as const)
  };
}
export function recordingChunkLength(
  manifest: MeetingRecordingUploadManifest,
  kind: RecordingSourceKind,
  index: number
) {
  if (!Number.isSafeInteger(index) || index < 0) invalid();
  const remaining = manifest[kind].byteLength - index * RECORDING_SOURCE_LIMITS.chunk;
  if (remaining <= 0) invalid();
  return Math.min(remaining, RECORDING_SOURCE_LIMITS.chunk);
}
