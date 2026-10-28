import { createHash } from "node:crypto";
import { assertUuid } from "@moss/db";
import type { RecordingMemorySource } from "@moss/shared";

export class RecordingMemoryUnavailableError extends Error {
  constructor() {
    super("This recording memory is unavailable");
    this.name = "RecordingMemoryUnavailableError";
  }
}
export class RecordingMemoryConflictError extends Error {
  constructor() {
    super("This recording memory has changed; refresh its current review");
    this.name = "RecordingMemoryConflictError";
  }
}
export class RecordingMemoryInputError extends Error {
  constructor() {
    super("Recording facts require nonempty text of at most 2048 UTF-8 bytes");
    this.name = "RecordingMemoryInputError";
  }
}

export function validateRecordingMemorySource(source: RecordingMemorySource): void {
  assertUuid(source.sourceId, "Recording source ID");
  if (
    source.sourceModuleId !== "meetings" ||
    !Number.isSafeInteger(source.sourceVersion) ||
    source.sourceVersion < 1 ||
    source.sourceVersion > 2147483645 ||
    !/^[a-zA-Z0-9_-]{1,80}$/.test(source.itemKey)
  )
    throw new RecordingMemoryUnavailableError();
}

export function recordingMemoryReceiptId(owner: string, source: RecordingMemorySource): string {
  assertUuid(owner, "Recording memory owner");
  validateRecordingMemorySource(source);
  return createHash("sha256")
    .update(
      JSON.stringify([
        "recording-memory-v1",
        owner.toLowerCase(),
        source.sourceModuleId,
        source.sourceId.toLowerCase(),
        source.sourceVersion,
        source.itemKey
      ])
    )
    .digest("hex");
}

/** Keep reviewed text byte-exact; whitespace-only and NUL content are invalid. */
export function validateRecordingFactText(text: string): void {
  if (
    typeof text !== "string" ||
    !text.trim() ||
    text.includes("\0") ||
    Buffer.from(text, "utf8").toString("utf8") !== text ||
    Buffer.byteLength(text, "utf8") > 2048
  )
    throw new RecordingMemoryInputError();
}

export function validateRecordingMemoryRevision(revision: number): void {
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 2147483645)
    throw new RecordingMemoryConflictError();
}

export function validateRecordingMemoryReceiptId(receiptId: string): void {
  if (!/^[a-f0-9]{64}$/.test(receiptId)) throw new RecordingMemoryUnavailableError();
}
