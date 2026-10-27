import {
  appendRecordingNoteBlock,
  changeRecordingNoteBlock,
  inspectRecordingNoteBlock,
  NoteBlockConflictError,
  type RecordingNoteBlock
} from "./recording-note-blocks.js";

/** Persist this intent before publication; never infer an intent from arbitrary current bytes. */
export interface PendingRecordingNoteOperation {
  readonly before: RecordingNoteBlock | null;
  readonly after: RecordingNoteBlock | null;
}

/**
 * Reconciles only an owning receipt's durable pending operation. Recognizing the exact desired
 * block recovers a crash after filesystem publication but before the operation's DB commit.
 * An ordinary replay of an applied receipt must inspect, never call this to recreate its block.
 */
export function reconcileRecordingNoteOperation(
  note: string,
  pending: PendingRecordingNoteOperation
): { readonly content: string; readonly status: "changed" | "already_published" } {
  const { before, after } = pending;
  if (!before && !after) throw new Error("A note operation needs a source block");
  if (before && after && before.id !== after.id)
    throw new Error("A note operation must retain its block identity");

  if (after && inspectRecordingNoteBlock(note, after) === "unchanged") {
    return { content: note, status: "already_published" };
  }
  if (before) {
    const current = inspectRecordingNoteBlock(note, before);
    if (!after && current === "missing") return { content: note, status: "already_published" };
    if (current !== "unchanged") throw new NoteBlockConflictError();
    return { content: changeRecordingNoteBlock(note, before, after), status: "changed" };
  }
  return { content: appendRecordingNoteBlock(note, after!), status: "changed" };
}
