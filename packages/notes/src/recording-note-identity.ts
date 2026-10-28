import { createHash } from "node:crypto";
import { assertUuid } from "@moss/db";
import type { RecordingNoteSource } from "@moss/shared";
export type { RecordingNoteSource } from "@moss/shared";

export function validateRecordingNoteSource(source: RecordingNoteSource): void {
  if (source.sourceModuleId !== "meetings") throw new Error("Unsupported recording source module");
  assertUuid(source.sourceId, "Recording source ID");
  if (
    !Number.isSafeInteger(source.sourceVersion) ||
    source.sourceVersion < 1 ||
    source.sourceVersion > 2147483647
  ) {
    throw new Error("Invalid recording source version");
  }
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(source.itemKey)) throw new Error("Invalid recording item key");
}

/** Side is deliberately absent: moving an existing contribution retains its source identity. */
export function recordingNoteBlockId(ownerUserId: string, source: RecordingNoteSource): string {
  assertUuid(ownerUserId, "Recording note owner");
  validateRecordingNoteSource(source);
  return createHash("sha256")
    .update("moss:recording-note-block:v1\0")
    .update(
      JSON.stringify([
        ownerUserId.toLowerCase(),
        source.sourceModuleId,
        source.sourceId.toLowerCase(),
        source.sourceVersion,
        source.itemKey
      ])
    )
    .digest("hex");
}

export function recordingFallbackReference(
  source: RecordingNoteSource,
  side: "personal" | "work"
): string {
  validateRecordingNoteSource(source);
  if (side !== "personal" && side !== "work") throw new Error("Invalid recording side");
  return `notes/recordings/${side}/${source.sourceId.toLowerCase()}/v${source.sourceVersion}.md`;
}
