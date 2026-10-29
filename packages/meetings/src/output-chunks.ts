import type { MeetingOutputInputs } from "@moss/shared";

/** One ordered piece of meeting evidence, cut so its prompt can fit the structured cap. */
export interface MeetingOutputChunk {
  /** Evidence shown to the model for this piece. Notes are a contiguous slice. */
  readonly inputs: MeetingOutputInputs;
  /** All evidence up to and including this piece. Piece answers are checked against this. */
  readonly seenInputs: MeetingOutputInputs;
  /** Offset of this piece's notes slice inside the full notes text. */
  readonly notesStart: number;
  readonly notesEnd: number;
  readonly segmentStart: number;
  readonly segmentEnd: number;
}

const NOTES_SLICE_CHARACTERS = 1000;

function sliceInputs(
  inputs: MeetingOutputInputs,
  segmentStart: number,
  segmentEnd: number,
  notesStart: number,
  notesEnd: number
): MeetingOutputInputs {
  return {
    ...inputs,
    personalNotes: inputs.personalNotes.slice(notesStart, notesEnd),
    transcript: inputs.transcript
      ? {
          ...inputs.transcript,
          segments: inputs.transcript.segments.slice(segmentStart, segmentEnd)
        }
      : inputs.transcript
  };
}

function chunk(
  inputs: MeetingOutputInputs,
  segmentStart: number,
  segmentEnd: number,
  notesStart: number,
  notesEnd: number
): MeetingOutputChunk {
  return {
    inputs: sliceInputs(inputs, segmentStart, segmentEnd, notesStart, notesEnd),
    seenInputs: sliceInputs(inputs, 0, segmentEnd, 0, notesEnd),
    notesStart,
    notesEnd,
    segmentStart,
    segmentEnd
  };
}

/** End of the next notes slice, preferring a space or newline near the limit. */
function nextNotesEnd(notes: string, start: number): number {
  if (start + NOTES_SLICE_CHARACTERS >= notes.length) return notes.length;
  const limit = start + NOTES_SLICE_CHARACTERS;
  const boundary = Math.max(notes.lastIndexOf("\n", limit), notes.lastIndexOf(" ", limit));
  let end = boundary > start ? boundary + 1 : limit;
  const before = notes.charCodeAt(end - 1);
  if (before >= 0xd800 && before <= 0xdbff) end -= 1;
  return end;
}

/**
 * Cut evidence into ordered pieces. Segments are never cut. The caller's fits check
 * measures the real prompt for a candidate piece, so cutting follows prompt bytes,
 * not a fixed segment count. Inputs that fit return as one unchanged piece.
 */
export function planMeetingOutputChunks(
  inputs: MeetingOutputInputs,
  fits: (candidate: MeetingOutputInputs) => boolean
): MeetingOutputChunk[] {
  if (fits(inputs))
    return [
      chunk(inputs, 0, inputs.transcript?.segments.length ?? 0, 0, inputs.personalNotes.length)
    ];
  const segmentCount = inputs.transcript?.segments.length ?? 0;
  const chunks: MeetingOutputChunk[] = [];
  let segmentStart = 0;
  let notesStart = 0;
  while (segmentStart < segmentCount || notesStart < inputs.personalNotes.length) {
    let segmentEnd = segmentStart;
    let notesEnd = notesStart;
    let grew = true;
    while (grew) {
      grew = false;
      while (
        segmentEnd < segmentCount &&
        fits(sliceInputs(inputs, segmentStart, segmentEnd + 1, notesStart, notesEnd))
      ) {
        segmentEnd += 1;
        grew = true;
      }
      while (notesEnd < inputs.personalNotes.length) {
        const next = nextNotesEnd(inputs.personalNotes, notesEnd);
        if (!fits(sliceInputs(inputs, segmentStart, segmentEnd, notesStart, next))) break;
        notesEnd = next;
        grew = true;
      }
    }
    if (segmentEnd === segmentStart && notesEnd === notesStart) {
      // Nothing fits even alone. Take one unit so the caller can cut it smaller or fail plainly.
      if (segmentEnd < segmentCount) segmentEnd += 1;
      else notesEnd = nextNotesEnd(inputs.personalNotes, notesEnd);
    }
    chunks.push(chunk(inputs, segmentStart, segmentEnd, notesStart, notesEnd));
    segmentStart = segmentEnd;
    notesStart = notesEnd;
  }
  return chunks;
}

/** Split one piece into two ordered pieces, or return null when it cannot be split. */
export function splitMeetingOutputChunk(
  inputs: MeetingOutputInputs,
  piece: MeetingOutputChunk
): [MeetingOutputChunk, MeetingOutputChunk] | null {
  const segments = piece.segmentEnd - piece.segmentStart;
  if (segments > 1) {
    const mid = piece.segmentStart + Math.floor(segments / 2);
    return [
      chunk(inputs, piece.segmentStart, mid, piece.notesStart, piece.notesEnd),
      chunk(inputs, mid, piece.segmentEnd, piece.notesStart, piece.notesEnd)
    ];
  }
  if (piece.notesEnd - piece.notesStart > NOTES_SLICE_CHARACTERS) {
    const mid = nextNotesEnd(inputs.personalNotes, piece.notesStart);
    if (mid >= piece.notesEnd) return null;
    return [
      chunk(inputs, piece.segmentStart, piece.segmentEnd, piece.notesStart, mid),
      chunk(inputs, piece.segmentStart, piece.segmentEnd, mid, piece.notesEnd)
    ];
  }
  return null;
}

/** Shift a piece answer's notes evidence back to offsets in the full notes text. */
export function shiftMeetingOutputChunkEvidence(value: unknown, notesStart: number): unknown {
  if (notesStart === 0) return value;
  if (Array.isArray(value))
    return value.map((item) => shiftMeetingOutputChunkEvidence(item, notesStart));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const shifted =
    record.kind === "personal-note" &&
    typeof record.startCharacter === "number" &&
    typeof record.endCharacter === "number"
      ? {
          ...record,
          startCharacter: record.startCharacter + notesStart,
          endCharacter: record.endCharacter + notesStart
        }
      : record;
  return Object.fromEntries(
    Object.entries(shifted).map(([key, item]) => [
      key,
      shiftMeetingOutputChunkEvidence(item, notesStart)
    ])
  );
}
