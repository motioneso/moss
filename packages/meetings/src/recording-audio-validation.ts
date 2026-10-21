import { RecordingImportInputError } from "./recording-validation-error.js";
function invalid(): never {
  throw new RecordingImportInputError();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/** Incremental legacy seq:u8, length:u8, payload framing; retains no source buffers. */
export class RecordingPacketValidator {
  private nextSequence: number | null = null;
  private awaitingLength = false;
  private remaining = 0;
  private count = 0;

  push(bytes: Uint8Array): void {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.remaining) {
        const consumed = Math.min(this.remaining, bytes.length - offset);
        this.remaining -= consumed;
        offset += consumed;
      } else if (this.awaitingLength) {
        this.remaining = bytes[offset++]!;
        if (!this.remaining) invalid();
        this.awaitingLength = false;
        this.count++;
      } else {
        const sequence = bytes[offset++]!;
        if (this.nextSequence !== null && sequence !== this.nextSequence) invalid();
        this.nextSequence = (sequence + 1) % 256;
        this.awaitingLength = true;
      }
    }
  }

  finish(): number {
    if (this.awaitingLength || this.remaining || !this.count) invalid();
    return this.count;
  }
}

export function recordingWavDuration(
  header: Buffer,
  byteLength: number,
  maxDurationMs: number
): number {
  // Canonical 16 kHz mono PCM16 only; the uploader normalizes decoder output.
  // latin1 compares tag bytes literally; Node's ascii decoder strips bit 7.
  if (
    header.length < 44 ||
    byteLength < 46 ||
    !Number.isSafeInteger(byteLength) ||
    header.toString("latin1", 0, 4) !== "RIFF" ||
    header.readUInt32LE(4) !== byteLength - 8 ||
    header.toString("latin1", 8, 16) !== "WAVEfmt " ||
    header.readUInt32LE(16) !== 16 ||
    header.readUInt16LE(20) !== 1 ||
    header.readUInt16LE(22) !== 1 ||
    header.readUInt32LE(24) !== 16000 ||
    header.readUInt32LE(28) !== 32000 ||
    header.readUInt16LE(32) !== 2 ||
    header.readUInt16LE(34) !== 16 ||
    header.toString("latin1", 36, 40) !== "data" ||
    header.readUInt32LE(40) !== byteLength - 44 ||
    (byteLength - 44) % 2
  )
    invalid();
  const duration = (byteLength - 44) / 32;
  if (duration > maxDurationMs) throw new RecordingImportInputError(413);
  if (!Number.isInteger(duration) || duration <= 0) invalid();
  return duration;
}
export function recordingSidecarMetadata(
  bytes: Buffer,
  durationMs: number,
  limits: { maxBytes: number; maxEntries: number; durationDigits: number }
) {
  if (bytes.length > limits.maxBytes) throw new RecordingImportInputError(413);
  let entries: unknown;
  try {
    entries = JSON.parse(`[${new TextDecoder("utf-8", { fatal: true }).decode(bytes)}]`);
  } catch {
    invalid();
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > limits.maxEntries) invalid();
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
          !/^\d+$/.test(pair[1]) ||
          pair[1].length > limits.durationDigits
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
