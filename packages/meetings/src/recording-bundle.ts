import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import type { MeetingRecordingFile, MeetingRecordingImportInput } from "@moss/shared";

import { RecordingImportInputError } from "./recording-validation-error.js";
import {
  RecordingPacketValidator,
  recordingWavDuration,
  recordingSidecarMetadata
} from "./recording-audio-validation.js";
export { RecordingImportInputError } from "./recording-validation-error.js";

export const RECORDING_IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
const LIMITS = { packets: 1024 * 1024, sidecar: 64 * 1024, wav: 3_840_044 };
function invalid(): never {
  throw new RecordingImportInputError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]) {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value)))
    invalid();
}
function file(value: unknown, limit: number): { manifest: MeetingRecordingFile; bytes: Buffer } {
  const input = object(value);
  keys(input, ["name", "base64", "sha256"]);
  if (
    typeof input.name !== "string" ||
    typeof input.base64 !== "string" ||
    typeof input.sha256 !== "string"
  )
    invalid();
  if (input.base64.length > 4 * Math.ceil(limit / 3)) throw new RecordingImportInputError(413);
  if (!input.base64.length || input.base64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(input.base64))
    invalid();
  const bytes = Buffer.from(input.base64, "base64");
  if (bytes.length > limit) throw new RecordingImportInputError(413);
  if (
    bytes.toString("base64") !== input.base64 ||
    !/^[a-f0-9]{64}$/.test(input.sha256) ||
    hash(bytes) !== input.sha256
  )
    invalid();
  return { manifest: { name: input.name, base64: input.base64, sha256: input.sha256 }, bytes };
}
function hash(input: string | Uint8Array) {
  return createHash("sha256").update(input).digest("hex");
}
export function validateRecordingBundle(value: unknown) {
  const input = object(value);
  keys(input, ["version", "sourceDeviceId", "recordingId", "packets", "sidecar", "wav"]);
  if (
    input.version !== 1 ||
    typeof input.sourceDeviceId !== "string" ||
    !isUuid(input.sourceDeviceId) ||
    typeof input.recordingId !== "string" ||
    !/^(?:amsg_)?[0-9]{10}_[A-Za-z0-9_-]{1,24}$/.test(input.recordingId)
  )
    invalid();
  const packets = file(input.packets, LIMITS.packets),
    sidecar = file(input.sidecar, LIMITS.sidecar),
    wav = file(input.wav, LIMITS.wav);
  if (
    packets.manifest.name !== `${input.recordingId}.opus` ||
    sidecar.manifest.name !== `${input.recordingId}.json` ||
    wav.manifest.name !== `${input.recordingId}.wav`
  )
    invalid();
  const validator = new RecordingPacketValidator();
  validator.push(packets.bytes);
  const count = validator.finish(),
    durationMs = recordingWavDuration(wav.bytes, wav.bytes.length, 120_000);
  // Legacy firmware emits 20ms or 60ms packets. No claim of independent Opus decoding.
  if (durationMs < count * 20 || durationMs > count * 60) invalid();
  const metadata = recordingSidecarMetadata(sidecar.bytes, durationMs, {
    maxBytes: LIMITS.sidecar,
    maxEntries: 512,
    durationDigits: 6
  });
  const manifest: MeetingRecordingImportInput = {
    version: 1,
    sourceDeviceId: input.sourceDeviceId.toLowerCase(),
    recordingId: input.recordingId,
    packets: packets.manifest,
    sidecar: sidecar.manifest,
    wav: wav.manifest
  };
  const canonical = JSON.stringify(manifest);
  return {
    manifest,
    canonical,
    fingerprint: hash(canonical),
    durationMs,
    ...metadata,
    mode: input.recordingId.startsWith("amsg_") ? ("voice-request" as const) : ("normal" as const)
  };
}
export type RecordingBundle = ReturnType<typeof validateRecordingBundle>;
