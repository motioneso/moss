import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { MeetingTranscriptEvent, MeetingTranscriptSource } from "@moss/shared";

/** Search-only normalization: never applied to stored evidence, source labels, or identity. */
export function normalizeMeetingSearchText(value: string): string {
  return value.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (part) =>
    part.length === 2 ? part : " "
  );
}

/** Bounded display text only; original generated evidence stays in artifact_json unchanged. */
export function projectMeetingOverview(value: string): string {
  return [...normalizeMeetingSearchText(value).replace(/\0/g, "").replace(/\s+/gu, " ").trim()]
    .slice(0, 240)
    .join("");
}

export function projectMeetingSources(sources: readonly MeetingTranscriptSource[]) {
  const unique = new Map<string, Pick<MeetingTranscriptSource, "kind" | "label">>();
  for (const { kind, label } of sources) unique.set(JSON.stringify([kind, label]), { kind, label });
  return {
    history_sources_json: JSON.stringify([...unique.values()].slice(0, 4)),
    history_omitted_sources: Math.max(0, unique.size - 4)
  };
}

/** The caller has validated this batch under its existing owner record lock. */
export async function projectMeetingSegments(
  db: DataContextDb,
  meetingId: string,
  events: readonly MeetingTranscriptEvent[]
) {
  assertDataContextDb(db);
  const latest = new Map<string, MeetingTranscriptEvent["segment"]>();
  for (const { segment } of events) {
    const previous = latest.get(segment.segmentId);
    if (!previous || previous.revision < segment.revision) latest.set(segment.segmentId, segment);
  }
  if (!latest.size) return;
  await db.db
    .insertInto("app.meeting_history_segments")
    .values(
      [...latest.values()].map((segment) => ({
        meeting_id: meetingId,
        segment_key: JSON.stringify(segment.segmentId),
        revision: segment.revision,
        start_ms: segment.startMs,
        end_ms: segment.endMs,
        finality: segment.finality,
        search_terms: sql<
          string[]
        >`tsvector_to_array(to_tsvector('simple'::regconfig, ${normalizeMeetingSearchText(segment.text)}))`
      }))
    )
    .onConflict((conflict) =>
      conflict
        .columns(["meeting_id", "segment_key"])
        .doUpdateSet((eb) => ({
          revision: eb.ref("excluded.revision"),
          start_ms: eb.ref("excluded.start_ms"),
          end_ms: eb.ref("excluded.end_ms"),
          finality: eb.ref("excluded.finality"),
          search_terms: eb.ref("excluded.search_terms")
        }))
        .whereRef("app.meeting_history_segments.revision", "<", "excluded.revision")
    )
    .execute();
}

export function projectMeetingRequestInput(input: string) {
  const value = JSON.parse(input) as { kind?: unknown };
  return { history_kind: typeof value.kind === "string" ? value.kind : null };
}
export function projectMeetingRequestResult(result: unknown) {
  const value =
    result && typeof result === "object" ? (result as { status?: unknown; code?: unknown }) : {};
  return {
    history_result_status: typeof value.status === "string" ? value.status : null,
    history_result_code: typeof value.code === "string" ? value.code : null
  };
}
