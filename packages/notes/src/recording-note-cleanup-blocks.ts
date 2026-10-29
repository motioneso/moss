import {
  changeRecordingNoteBlock,
  inspectRecordingNoteBlock,
  NoteBlockConflictError,
  type RecordingNoteBlock
} from "./recording-note-blocks.js";

/** Removal recognizes only exact durable before/after variants, including a crashed publication. */
export function removeRecordingContributionBlocks(
  content: string,
  variants: readonly RecordingNoteBlock[]
): string {
  const first = variants[0];
  if (!first || variants.some((block) => block.id !== first.id)) {
    throw new Error("Cleanup needs exact variants of one source-owned block");
  }
  for (const block of variants) {
    if (inspectRecordingNoteBlock(content, block) === "unchanged") {
      return changeRecordingNoteBlock(content, block, null);
    }
  }
  if (inspectRecordingNoteBlock(content, first) === "missing") return content;
  throw new NoteBlockConflictError();
}
