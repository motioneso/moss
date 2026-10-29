import { describe, expect, it } from "vitest";
import type { MeetingOutputInputs, MeetingTranscriptSegment } from "@moss/shared";
import {
  planMeetingOutputChunks,
  shiftMeetingOutputChunkEvidence,
  splitMeetingOutputChunk
} from "../../packages/meetings/src/output-chunks.js";

const segment = (index: number, text: string): MeetingTranscriptSegment => ({
  meetingId: "meeting",
  segmentId: `segment-${index}`,
  sourceId: "microphone",
  epoch: 1,
  startMs: index * 1000,
  endMs: index * 1000 + 1000,
  revision: 1,
  text,
  finality: "final",
  provenance: "transcription",
  speakerId: null
});

function inputs(overrides: Partial<MeetingOutputInputs> = {}): MeetingOutputInputs {
  return {
    meetingId: "meeting",
    notesRevision: 1,
    personalNotes: "",
    transcript: {
      meetingId: "meeting",
      ownerUserId: "owner",
      transcriptRevision: 1,
      cutoffMs: 1000,
      maxSegments: 500,
      maxCharacters: 100000,
      cursor: 1,
      throughMs: 1000,
      omittedSegments: 0,
      containsProvisional: false,
      segments: []
    },
    ...overrides
  };
}

const fitsByCharacters = (limit: number) => (candidate: MeetingOutputInputs) =>
  JSON.stringify(candidate).length <= limit;

describe("meeting output chunks", () => {
  it("returns fitting inputs as one unchanged piece", () => {
    const source = inputs({ personalNotes: "short note" });
    const chunks = planMeetingOutputChunks(source, () => true);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.inputs.personalNotes).toBe("short note");
    expect(chunks[0]!.notesStart).toBe(0);
  });

  it("cuts segments in order with none dropped or repeated", () => {
    const segments = Array.from({ length: 10 }, (_, index) => segment(index, "x".repeat(200)));
    const source = inputs({
      transcript: { ...inputs().transcript!, segments }
    });
    const chunks = planMeetingOutputChunks(source, fitsByCharacters(1200));
    expect(chunks.length).toBeGreaterThan(1);
    expect(
      chunks.flatMap((chunk) => chunk.inputs.transcript!.segments.map((item) => item.segmentId))
    ).toEqual(segments.map((item) => item.segmentId));
    const last = chunks[chunks.length - 1]!;
    expect(last.seenInputs.transcript!.segments).toHaveLength(10);
  });

  it("covers the whole notes in contiguous slices and shifts evidence back", () => {
    const notes = Array.from({ length: 50 }, (_, index) => `sentence ${index} has words.`).join(
      " "
    );
    const source = inputs({ personalNotes: notes });
    const chunks = planMeetingOutputChunks(source, fitsByCharacters(900));
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((chunk) => chunk.inputs.personalNotes).join("")).toBe(notes);
    const second = chunks[1]!;
    const citation = {
      kind: "personal-note",
      meetingId: "meeting",
      notesRevision: 1,
      startCharacter: 0,
      endCharacter: 8
    };
    const shifted = shiftMeetingOutputChunkEvidence(
      { decisions: [{ evidence: [citation] }] },
      second.notesStart
    ) as {
      decisions: { evidence: { startCharacter: number; endCharacter: number }[] }[];
    };
    const evidence = shifted.decisions[0]!.evidence[0]!;
    expect(notes.slice(evidence.startCharacter, evidence.endCharacter)).toBe(
      second.inputs.personalNotes.slice(0, 8)
    );
  });

  it("splits a piece into two ordered pieces that keep the same seen evidence", () => {
    const segments = Array.from({ length: 8 }, (_, index) => segment(index, "y".repeat(100)));
    const source = inputs({ transcript: { ...inputs().transcript!, segments } });
    const [whole] = planMeetingOutputChunks(source, () => true);
    const split = splitMeetingOutputChunk(source, whole!);
    expect(split).not.toBeNull();
    expect(split![0].inputs.transcript!.segments.map((item) => item.segmentId)).toEqual([
      "segment-0",
      "segment-1",
      "segment-2",
      "segment-3"
    ]);
    expect(split![1].seenInputs.transcript!.segments).toHaveLength(8);
  });
});
