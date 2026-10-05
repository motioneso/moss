import { describe, expect, it } from "vitest";
import {
  normalizeMeetingSearchText,
  projectMeetingRequestInput,
  projectMeetingRequestResult,
  projectMeetingSegments,
  projectMeetingSources
} from "../../packages/meetings/src/history-projection.js";
import {
  MeetingHistoryInputError,
  validateMeetingHistoryInput
} from "../../packages/meetings/src/history-repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import type { MeetingTranscriptSegment } from "@moss/shared";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const segment: MeetingTranscriptSegment = {
  meetingId: id,
  segmentId: "first",
  sourceId: "mic",
  epoch: 1,
  startMs: 0,
  endMs: 10,
  revision: 1,
  text: "first \ud800 word 😀",
  finality: "provisional",
  provenance: "transcription",
  speakerId: null
};
describe("meeting history projection", () => {
  it("normalizes only lone search surrogates and preserves valid pairs and literal escapes", () => {
    expect(normalizeMeetingSearchText("a\ud800b\udfff c😀d \\ud800")).toBe("a b  c😀d \\ud800");
  });
  it("keeps exact UTF16 identities distinct and collapses same-batch revisions to the newest", async () => {
    const { scoped, queries } = makeRecordingDb();
    await projectMeetingSegments(scoped, id, [
      { cursor: 1, segment: { ...segment, segmentId: "\ud800" } },
      { cursor: 2, segment: { ...segment, segmentId: "\ud801" } },
      {
        cursor: 3,
        segment: {
          ...segment,
          segmentId: "\ud800",
          revision: 2,
          text: "corrected",
          finality: "final"
        }
      }
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0]?.parameters).toContain(JSON.stringify("\ud800"));
    expect(queries[0]?.parameters).toContain(JSON.stringify("\ud801"));
    expect(queries[0]?.parameters).toContain("corrected");
    expect(queries[0]?.parameters).toContain("first   word 😀");
    expect(queries[0]?.sql).toContain(
      '"app"."meeting_history_segments"."revision" < "excluded"."revision"'
    );
    expect(queries[0]?.sql).not.toContain("jsonb");
  });
  it("caps distinct source pairs with omissions without changing labels", () => {
    const sources = Array.from({ length: 6 }, (_, index) => ({
      sourceId: `s${index}`,
      epoch: 1,
      kind: "microphone" as const,
      label: `${index}\ud800`,
      startMs: 0,
      endMs: 1
    }));
    const result = projectMeetingSources([...sources, sources[0]!]);
    expect(result.history_omitted_sources).toBe(2);
    expect(JSON.parse(result.history_sources_json)).toEqual(
      sources.slice(0, 4).map(({ kind, label }) => ({ kind, label }))
    );
  });
  it("extracts narrow metadata without asking PostgreSQL to decode unrelated JSON Unicode", () => {
    expect(
      projectMeetingRequestInput(JSON.stringify({ kind: "generate", body: "\ud800\0" }))
    ).toEqual({ history_kind: "generate" });
    expect(
      projectMeetingRequestResult({ status: "saved", artifact: { overview: "\0\ud800" } })
    ).toEqual({ history_result_status: "saved", history_result_code: null });
  });
});
describe("meeting history input", () => {
  it.each([
    { query: "x".repeat(257) },
    { query: "漢".repeat(180) },
    { query: "\0" },
    { limit: 0 },
    { limit: 51 },
    { limit: 1.5 },
    { filter: "recording" },
    { query: null },
    { before: null },
    { before: { id, createdAt: "2026-10-04" } },
    { before: { id } },
    { extra: "hidden" }
  ])("rejects unsupported bounded input %j", (input) => {
    expect(() => validateMeetingHistoryInput(input as never)).toThrow(MeetingHistoryInputError);
  });
  it("keeps canonical cursors and trims query whitespace without changing semantics", () => {
    expect(
      validateMeetingHistoryInput({
        query: "  Words  ",
        before: { id, createdAt: "2026-10-04T00:00:00.000Z" }
      })
    ).toEqual({
      query: "Words",
      filter: "all",
      limit: 30,
      before: { id, createdAt: "2026-10-04T00:00:00.000Z" }
    });
  });
});
