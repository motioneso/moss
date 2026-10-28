const MAX_CONTRIBUTION_BYTES = 16 * 1024;
const FORMAT = "moss-recording:v1";

export class NoteBlockConflictError extends Error {
  constructor() {
    super("The recording's note block is missing, duplicated or changed; review current content");
    this.name = "NoteBlockConflictError";
  }
}

/** The receipt retains these exact bytes; undo never restores a whole-file snapshot. */
export interface RecordingNoteBlock {
  readonly id: string;
  readonly bytes: string;
}

function markers(id: string) {
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid recording block identity");
  const prefix = `<!-- ${FORMAT}:${id}:`;
  return { prefix, begin: `${prefix}begin -->`, end: `${prefix}end -->` };
}

export function renderRecordingNoteBlock(id: string, text: string): RecordingNoteBlock {
  const { begin, end } = markers(id);
  if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_CONTRIBUTION_BYTES) {
    throw new Error("A note contribution requires 1 to 16384 UTF-8 bytes");
  }
  if (Buffer.from(text, "utf8").toString("utf8") !== text) {
    throw new Error("A note contribution requires well-formed Unicode text");
  }
  // Proposed prose cannot introduce any second executable managed-block marker.
  const escaped = text.replaceAll("<!--", "&lt;!--");
  if (Buffer.byteLength(escaped, "utf8") > MAX_CONTRIBUTION_BYTES) {
    throw new Error("Escaped note contribution exceeds 16384 UTF-8 bytes");
  }
  return { id, bytes: `\n${begin}\n${escaped}\n${end}\n` };
}

export type NoteBlockObservation = "missing" | "unchanged" | "conflict";

export function inspectRecordingNoteBlock(
  note: string,
  block: RecordingNoteBlock
): NoteBlockObservation {
  const { prefix, begin, end } = markers(block.id);
  const markerCount = note.split(prefix).length - 1;
  if (markerCount === 0) return "missing";
  if (
    markerCount !== 2 ||
    note.split(begin).length !== 2 ||
    note.split(end).length !== 2 ||
    !note.includes(block.bytes)
  ) {
    return "conflict";
  }
  return "unchanged";
}

/** Adds or recognizes an exact block. The owning receipt decides when creation is permitted. */
export function appendRecordingNoteBlock(note: string, block: RecordingNoteBlock): string {
  const state = inspectRecordingNoteBlock(note, block);
  if (state === "conflict") throw new NoteBlockConflictError();
  return state === "unchanged" ? note : note + block.bytes;
}

/** Changed/deleted markers conflict; callers must distinguish explicit restore from replay. */
export function changeRecordingNoteBlock(
  note: string,
  before: RecordingNoteBlock,
  after: RecordingNoteBlock | null
): string {
  if (after && before.id !== after.id)
    throw new Error("A note change must retain its block identity");
  if (inspectRecordingNoteBlock(note, before) !== "unchanged") throw new NoteBlockConflictError();
  const at = note.indexOf(before.bytes);
  const prefix = note.slice(0, at);
  const suffix = note.slice(at + before.bytes.length);
  if (after) return prefix + after.bytes + suffix;
  // A later append may use our trailing newline. Retain a line boundary between the two
  // surviving user sections rather than joining their text when removing the middle block.
  const boundary =
    prefix && suffix && !prefix.endsWith("\n") && !suffix.startsWith("\n") ? "\n" : "";
  return prefix + boundary + suffix;
}
