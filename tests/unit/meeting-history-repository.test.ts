import { describe, expect, it } from "vitest";
import {
  MeetingHistoryRepository,
  meetingHistoryItem
} from "../../packages/meetings/src/history-repository.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const row = {
  id,
  title: "Retained meeting",
  created_at: new Date("2026-10-04T00:00:00.000Z"),
  updated_at: new Date("2026-10-04T00:00:00.000Z"),
  has_notes: true,
  notes_revision: 2,
  transcript_revision: 3,
  segment_count: 2,
  final_count: 1,
  provisional_count: 1,
  start_ms: 10,
  end_ms: 30,
  sources_json: '[{"kind":"microphone","label":"Mic"}]',
  omitted_sources: 1,
  output_version: 2,
  output_origin: "manual" as const,
  output_created_at: new Date("2026-10-04T00:00:00.000Z"),
  output_stale: true,
  generation_status: "failed" as const,
  generation_expires_at: new Date("2026-10-04T00:00:00.000Z"),
  pending_count: 2,
  accepted_count: 1,
  dismissed_count: 1,
  vault_version: 2,
  vault_write_status: "failed" as const,
  vault_index_status: "not-requested" as const,
  vault_updated_at: "2026-10-04T00:00:00.000Z",
  saved_count: 1
};
describe("meeting history repository", () => {
  it("keeps independent facts and emits metadata only", () => {
    const item = meetingHistoryItem(row);
    expect(item.capture).toEqual({ status: "unavailable", durationMs: null });
    expect(item.summary).toMatchObject({
      status: "stale",
      version: 2,
      generation: { status: "failed" }
    });
    expect(item.vault).toMatchObject({
      savedVersionCount: 1,
      latest: { artifactVersion: 2, writeStatus: "failed" }
    });
    expect(item.actions.accepted).toBe(1);
    expect(item.transcript.span).toEqual({ startMs: 10, endMs: 30 });
    expect(Object.keys(item)).not.toContain("personalNotes");
  });
  it("uses limit-plus-one, stable cursor ordering and scalar page projection", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [row, { ...row, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }]
    });
    const result = await new MeetingHistoryRepository().search(scoped, {
      limit: 1,
      before: { id, createdAt: row.created_at.toISOString() }
    });
    expect(result.meetings).toHaveLength(1);
    expect(result.nextCursor).toEqual({ id, createdAt: row.created_at.toISOString() });
    expect(queries[0]?.sql).toContain("statement_timeout");
    const query = queries[1]!;
    expect(query.sql).toContain("(r.created_at, r.id) <");
    expect(query.sql).toContain("r.owner_user_id = app.current_actor_user_id()");
    expect(query.sql).not.toMatch(/input_json|artifact_json|result_json|receipt_json|::jsonb/);
  });
  it("matches all normalized terms against independent current documents before metadata pagination", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ ...row, terms: ["first", "second"] }] });
    const result = await new MeetingHistoryRepository().search(scoped, {
      query: "First Second",
      filter: "transcript"
    });
    expect(result.meetings).toHaveLength(1);
    const query = queries[2]!;
    expect(query.sql.match(/r\.id IN/g)).toHaveLength(2);
    expect(query.sql).toContain("history_search_terms @> ARRAY[");
    expect(query.sql).toContain("s.search_terms @> ARRAY[");
    expect(query.sql).toContain("WHERE segment_count > 0");
    expect(query.parameters.filter((value) => value === "first")).toHaveLength(2);
    expect(query.parameters.filter((value) => value === "second")).toHaveLength(2);
    expect(query.parameters).not.toContain("First Second");
  });
  it("returns no match for punctuation-only input without issuing a metadata query", async () => {
    const { scoped, queries } = makeRecordingDb({ rows: [{ terms: [] }] });
    expect(await new MeetingHistoryRepository().search(scoped, { query: "!!!" })).toEqual({
      meetings: [],
      nextCursor: null
    });
    expect(queries).toHaveLength(2);
  });
  it("rejects excess normalized terms rather than truncating", async () => {
    const { scoped, queries } = makeRecordingDb({
      rows: [{ terms: Array.from({ length: 17 }, (_, i) => `term${i}`) }]
    });
    await expect(
      new MeetingHistoryRepository().search(scoped, { query: "many words" })
    ).rejects.toThrow("Invalid meeting history query");
    expect(queries).toHaveLength(2);
  });
  it("bounds selected detail to an owner-visible identity", async () => {
    const { scoped, queries } = makeRecordingDb();
    expect(await new MeetingHistoryRepository().get(scoped, id)).toBeNull();
    expect(queries[1]?.sql).toContain("r.id =");
    expect(queries[1]?.parameters).toContain(id);
  });
});
