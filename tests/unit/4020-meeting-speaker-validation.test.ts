import { describe, expect, it } from "vitest";
import type { MeetingOutputInputs, MeetingTranscriptSegment } from "@moss/shared";
import {
  MeetingOutputValidationError,
  validateMeetingOutput
} from "../../packages/meetings/src/output-validation.js";

const seg = (
  segmentId: string,
  text: string,
  speakerId: string | null
): MeetingTranscriptSegment => ({
  meetingId: "m",
  segmentId,
  sourceId: "mic",
  epoch: 1,
  startMs: 0,
  endMs: 1000,
  revision: 1,
  text,
  finality: "final",
  provenance: "transcription",
  speakerId
});

const inputs: MeetingOutputInputs = {
  meetingId: "m",
  notesRevision: 0,
  personalNotes: "",
  transcript: {
    meetingId: "m",
    ownerUserId: "o",
    transcriptRevision: 1,
    cutoffMs: 1000,
    maxSegments: 10,
    maxCharacters: 1000,
    cursor: 1,
    throughMs: 1000,
    omittedSegments: 0,
    containsProvisional: false,
    segments: [
      seg("s1", "Hi, I am Jamie and I will send the plan.", "S1"),
      seg("s2", "Thanks Jamie, I will review it.", "S2")
    ]
  }
};

const base = {
  overview: "{{speaker:S1}} spoke.",
  decisions: [],
  openQuestions: [],
  actions: [],
  warnings: []
};
const entry = (over: Record<string, unknown> = {}) => ({
  speakerId: "S1",
  name: "Jamie",
  basis: "introduced-in-talk",
  confidence: "high",
  evidence: ["s1"],
  ...over
});
const run = (speakers: unknown, known: string[] = []) =>
  validateMeetingOutput({ ...base, speakers }, inputs, { knownNames: known });

describe("speaker validation", () => {
  it("keeps a supported name and keeps the token in text", () => {
    const out = run([entry()]);
    expect(out.speakers).toEqual([entry()]);
    expect(out.overview).toBe("{{speaker:S1}} spoke.");
  });
  it("accepts a null name with no evidence", () => {
    const out = run([entry({ name: null, evidence: [], basis: "inference", confidence: "low" })]);
    expect(out.speakers).toHaveLength(1);
  });
  it("drops a name with no evidence and adds one warning", () => {
    const out = run([entry({ evidence: [] })]);
    expect(out.speakers).toEqual([]);
    expect(out.warnings).toHaveLength(1);
  });
  it("drops a name whose evidence id is not in the transcript", () => {
    expect(run([entry({ evidence: ["nope"] })]).speakers).toEqual([]);
  });
  it("drops a name found in neither pack nor transcript", () => {
    expect(run([entry({ name: "Zed" })], ["Alex"]).speakers).toEqual([]);
  });
  it("drops a short name that only sits inside longer words", () => {
    // "ed" appears in "needed" and "reviewed" but nobody is called Ed.
    expect(run([entry({ name: "Ed" })]).speakers).toEqual([]);
  });
  it("accepts a name that is only in the pack", () => {
    const out = run([entry({ name: "Alex", basis: "calendar" })], ["Alex"]);
    expect(out.speakers?.[0]?.name).toBe("Alex");
  });
  it("forces calendar-only basis to low", () => {
    // s2 belongs to S2, so S1 has no speech evidence of its own.
    const out = run([entry({ name: "Alex", basis: "calendar", evidence: ["s2"] })], ["Alex"]);
    expect(out.speakers?.[0]?.confidence).toBe("low");
  });
  it("drops an entry for an unknown speaker id", () => {
    expect(run([entry({ speakerId: "S9" })]).speakers).toEqual([]);
  });
  it("accepts a capture source id as speaker id", () => {
    expect(run([entry({ speakerId: "mic" })]).speakers).toHaveLength(1);
  });
  it("keeps the first entry for a repeated speaker id", () => {
    const out = run([entry(), entry({ name: "Alex" })], ["Alex"]);
    expect(out.speakers).toHaveLength(1);
    expect(out.speakers?.[0]?.name).toBe("Jamie");
  });
  it("rejects a malformed block so the existing retry runs", () => {
    expect(() => run([entry({ basis: "vibes" })])).toThrow(MeetingOutputValidationError);
    expect(() => run([{ ...entry(), extra: 1 }])).toThrow(MeetingOutputValidationError);
    expect(() => run("nope")).toThrow(MeetingOutputValidationError);
  });
  it("rejects more than 20 entries", () => {
    expect(() => run(Array.from({ length: 21 }, () => entry()))).toThrow(
      MeetingOutputValidationError
    );
  });
  it("keeps an empty list as given", () => {
    expect(run([]).speakers).toEqual([]);
  });
  it("accepts a summary with no speakers key (legacy shape)", () => {
    expect(validateMeetingOutput(base, inputs).speakers).toBeUndefined();
  });
  it("holds 20 speakers inside the size cap", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({ speakerId: `S${i}`, name: null, evidence: [], basis: "inference", confidence: "low" })
    );
    const segs = many.map((m) => seg(`x${m.speakerId}`, "x", m.speakerId));
    const wide = {
      ...inputs,
      transcript: { ...inputs.transcript!, segments: [...inputs.transcript!.segments, ...segs] }
    };
    const out = validateMeetingOutput({ ...base, speakers: many }, wide, { knownNames: [] });
    expect(out.speakers).toHaveLength(20);
    expect(JSON.stringify(out).length).toBeLessThan(1_000_000);
  });
});
