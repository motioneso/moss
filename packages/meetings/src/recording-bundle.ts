import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import type { MeetingRecordingFile, MeetingRecordingImportInput } from "@moss/shared";

export const RECORDING_IMPORT_BODY_LIMIT = 8 * 1024 * 1024;
const LIMITS = { packets: 1024 * 1024, sidecar: 64 * 1024, wav: 3_840_044 };
export class RecordingImportInputError extends Error {
  constructor(readonly statusCode: 400 | 413 = 400) {
    super("Invalid completed recording bundle");
  }
}
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
function packetCount(bytes: Buffer): number {
  let count = 0,
    offset = 0,
    previous: number | null = null;
  while (offset < bytes.length) {
    if (offset + 2 > bytes.length) invalid();
    const sequence = bytes[offset]!,
      length = bytes[offset + 1]!;
    if (
      !length ||
      offset + 2 + length > bytes.length ||
      (previous !== null && sequence !== (previous + 1) % 256)
    )
      invalid();
    previous = sequence;
    offset += length + 2;
    count++;
  }
  if (!count) invalid();
  return count;
}
function wavDuration(bytes: Buffer): number {
  // Version 1 deliberately accepts only canonical PCM WAV; uploader normalizes decoder output.
  if (
    bytes.length < 46 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.readUInt32LE(4) !== bytes.length - 8 ||
    bytes.toString("ascii", 8, 16) !== "WAVEfmt " ||
    bytes.readUInt32LE(16) !== 16 ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.readUInt16LE(22) !== 1 ||
    bytes.readUInt32LE(24) !== 16000 ||
    bytes.readUInt32LE(28) !== 32000 ||
    bytes.readUInt16LE(32) !== 2 ||
    bytes.readUInt16LE(34) !== 16 ||
    bytes.toString("ascii", 36, 40) !== "data" ||
    bytes.readUInt32LE(40) !== bytes.length - 44 ||
    (bytes.length - 44) % 2
  )
    invalid();
  const duration = (bytes.length - 44) / 32;
  if (duration > 120_000) throw new RecordingImportInputError(413);
  if (!Number.isInteger(duration) || duration <= 0) invalid();
  return duration;
}
function sidecarMetadata(bytes: Buffer, durationMs: number) {
  let entries: unknown;
  try {
    entries = JSON.parse(`[${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}]`);
  } catch {
    invalid();
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 512) invalid();
  let startMs: number | null = null,
    endMs: number | null = null,
    recordedDurationMs: number | null = null;
  const bookmarks: number[] = [];
  function timestamp(value: unknown) {
    if (typeof value !== "string" || !/^\d{10,13}$/.test(value)) invalid();
    const result = Number(value) * (value.length === 10 ? 1000 : 1);
    if (!Number.isSafeInteger(result)) invalid();
    return result;
  }
  for (const item of entries) {
    const entry = object(item);
    for (const key of ["record", "btn", "duration"]) {
      if (!(key in entry)) continue;
      const pair = entry[key];
      if (!Array.isArray(pair) || pair.length !== 2) invalid();
      const at = timestamp(pair[0]);
      if (key === "record") {
        if (pair[1] === "start" && startMs === null) startMs = at;
        else if (pair[1] === "end" && endMs === null) endMs = at;
        else invalid();
      } else if (key === "btn") {
        if (pair[1] === "1") bookmarks.push(at);
      } else {
        if (
          recordedDurationMs !== null ||
          typeof pair[1] !== "string" ||
          !/^\d{1,6}$/.test(pair[1])
        )
          invalid();
        recordedDurationMs = Number(pair[1]);
      }
    }
  }
  if (
    startMs === null ||
    endMs === null ||
    endMs < startMs ||
    Math.abs(endMs - startMs - durationMs) > 1500 ||
    recordedDurationMs === null ||
    Math.abs(recordedDurationMs - durationMs) > 1000
  )
    invalid();
  const bookmarksMs = bookmarks.map((at) => at - startMs);
  if (bookmarksMs.some((at) => at < 0 || at > durationMs)) invalid();
  return { startMs, endMs, recordedDurationMs, bookmarksMs };
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
  const count = packetCount(packets.bytes),
    durationMs = wavDuration(wav.bytes);
  // Legacy firmware emits 20ms or 60ms packets. No claim of independent Opus decoding.
  if (durationMs < count * 20 || durationMs > count * 60) invalid();
  const metadata = sidecarMetadata(sidecar.bytes, durationMs);
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
