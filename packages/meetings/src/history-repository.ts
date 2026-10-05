import { sql, type RawBuilder } from "kysely";
import { assertDataContextDb, isUuid, type DataContextDb } from "@moss/db";
import type {
  MeetingHistoryFilter,
  MeetingHistoryItem,
  MeetingHistoryPage,
  SearchMeetingHistoryInput
} from "@moss/shared";
import { normalizeMeetingSearchText } from "./history-projection.js";

export class MeetingHistoryInputError extends Error {
  constructor() {
    super("Invalid meeting history query");
  }
}
export class MeetingHistoryUnavailableError extends Error {
  constructor() {
    super("Meeting history is temporarily unavailable");
  }
}
const filters: readonly MeetingHistoryFilter[] = [
  "all",
  "transcript",
  "needs-review",
  "exported",
  "notes-only"
];
const whitespace =
  "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
export function validateMeetingHistoryInput(input: SearchMeetingHistoryInput = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new MeetingHistoryInputError();
  const query = input.query ?? "";
  const filter = input.filter ?? "all";
  const limit = input.limit ?? 30;
  if (
    (input.query !== undefined && typeof input.query !== "string") ||
    (input.before !== undefined &&
      (!input.before || typeof input.before !== "object" || Array.isArray(input.before))) ||
    Object.keys(input).some((key) => !["query", "filter", "limit", "before"].includes(key)) ||
    typeof query !== "string" ||
    query.length > 256 ||
    Buffer.byteLength(query) > 512 ||
    query.includes("\0") ||
    !filters.includes(filter) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    throw new MeetingHistoryInputError();
  if (input.before) {
    const { id, createdAt } = input.before;
    const timestamp = new Date(createdAt);
    if (
      Object.keys(input.before).some((key) => key !== "id" && key !== "createdAt") ||
      !isUuid(id) ||
      !Number.isFinite(timestamp.getTime()) ||
      timestamp.toISOString() !== createdAt
    )
      throw new MeetingHistoryInputError();
  }
  return { query: query.trim(), filter, limit, before: input.before };
}
interface HistoryRow {
  id: string;
  title: string;
  created_at: Date;
  updated_at: Date;
  has_notes: boolean;
  notes_revision: number;
  transcript_revision: number;
  segment_count: number;
  final_count: number;
  provisional_count: number;
  start_ms: number | null;
  end_ms: number | null;
  sources_json: string;
  omitted_sources: number;
  output_version: number | null;
  output_origin: "generated" | "manual" | null;
  output_created_at: Date | null;
  output_stale: boolean;
  generation_status: "pending" | "failed" | "interrupted" | "saved" | null;
  generation_expires_at: Date | null;
  pending_count: number;
  accepted_count: number;
  dismissed_count: number;
  vault_version: number | null;
  vault_write_status: "pending" | "saved" | "failed" | "conflict" | null;
  vault_index_status: "not-requested" | "queued" | "delayed" | "conflict" | null;
  vault_updated_at: string | null;
  saved_count: number;
}
export function meetingHistoryItem(row: HistoryRow): MeetingHistoryItem {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    hasNotes: row.has_notes,
    notesRevision: row.notes_revision,
    capture: { status: "unavailable" },
    transcript: {
      status: row.segment_count ? "retained" : "none",
      revision: row.transcript_revision,
      segmentCount: row.segment_count,
      finalSegmentCount: row.final_count,
      provisionalSegmentCount: row.provisional_count,
      span:
        row.start_ms === null || row.end_ms === null
          ? null
          : { startMs: row.start_ms, endMs: row.end_ms },
      sources: JSON.parse(row.sources_json) as MeetingHistoryItem["transcript"]["sources"],
      omittedSourceCount: row.omitted_sources
    },
    summary: {
      status: row.output_version === null ? "none" : row.output_stale ? "stale" : "available",
      version: row.output_version,
      origin: row.output_origin,
      createdAt: row.output_created_at?.toISOString() ?? null,
      generation:
        row.generation_status && row.generation_expires_at
          ? { status: row.generation_status, expiresAt: row.generation_expires_at.toISOString() }
          : null
    },
    actions: {
      pending: row.pending_count,
      accepted: row.accepted_count,
      dismissed: row.dismissed_count
    },
    vault: {
      latest:
        row.vault_version !== null &&
        row.vault_write_status &&
        row.vault_index_status &&
        row.vault_updated_at
          ? {
              artifactVersion: row.vault_version,
              writeStatus: row.vault_write_status,
              indexStatus: row.vault_index_status,
              updatedAt: row.vault_updated_at
            }
          : null,
      savedVersionCount: row.saved_count
    }
  };
}
function stateFilter(filter: MeetingHistoryFilter): RawBuilder<boolean> {
  switch (filter) {
    case "transcript":
      return sql`segment_count > 0`;
    case "notes-only":
      return sql`has_notes AND segment_count = 0`;
    case "exported":
      return sql`saved_count > 0`;
    case "needs-review":
      return sql`pending_count > 0 OR provisional_count > 0 OR
      (output_version IS NOT NULL AND output_stale) OR generation_status IN ('failed','interrupted') OR
      vault_write_status IN ('failed','conflict') OR vault_index_status IN ('delayed','conflict')`;
    default:
      return sql`true`;
  }
}
/** Scalar/index reads only; no transcript reconstruction, provider, Tasks, or vault operations. */
export class MeetingHistoryRepository {
  private async read(
    db: DataContextDb,
    input: ReturnType<typeof validateMeetingHistoryInput>,
    id?: string
  ) {
    // Local to this read transaction. Do not silently truncate searchable meeting identities.
    await sql`select set_config('statement_timeout', '3000', true)`.execute(db.db);
    let search: RawBuilder<boolean> = sql`true`;
    if (input.query) {
      const normalized = await sql<{
        terms: string[];
      }>`select tsvector_to_array(to_tsvector('simple'::regconfig, ${normalizeMeetingSearchText(input.query)})) as terms`.execute(
        db.db
      );
      const terms = normalized.rows[0]?.terms ?? [];
      if (terms.length > 16) throw new MeetingHistoryInputError();
      if (!terms.length) return [];
      // Each independently indexed term may match any current document in this meeting.
      search = sql`${sql.join(
        terms.map(
          (term) => sql`r.id IN (
        SELECT d.id FROM app.meeting_records d
        WHERE d.owner_user_id = app.current_actor_user_id() AND d.history_search_terms @> ARRAY[${term}]::text[]
        UNION
        SELECT s.meeting_id FROM app.meeting_history_segments s
        WHERE s.owner_user_id = app.current_actor_user_id() AND s.search_terms @> ARRAY[${term}]::text[]
      )`
        ),
        sql` AND `
      )}`;
    }
    const cursor = input.before
      ? sql<boolean>`(r.created_at, r.id) < (${new Date(input.before.createdAt)}, ${input.before.id}::uuid)`
      : sql<boolean>`true`;
    const identity = id ? sql<boolean>`r.id = ${id}::uuid` : sql<boolean>`true`;
    const earlyLimit = input.filter === "all" ? sql`LIMIT ${input.limit + 1}` : sql``;
    const result = await sql<HistoryRow>`
      WITH records AS MATERIALIZED (
        SELECT r.id,r.title,r.created_at,r.updated_at,r.notes_revision,
          btrim(r.personal_notes, ${whitespace}) <> '' AS has_notes
        FROM app.meeting_records r
        WHERE r.owner_user_id = app.current_actor_user_id() AND ${identity} AND ${cursor} AND ${search}
        ORDER BY r.created_at DESC,r.id DESC ${earlyLimit}
      ), history AS (
        SELECT r.*, coalesce(t.transcript_revision,0) AS transcript_revision,
          s.segment_count,s.final_count,s.provisional_count,s.start_ms,s.end_ms,
          coalesce(t.history_sources_json,'[]') AS sources_json,coalesce(t.history_omitted_sources,0) AS omitted_sources,
          coalesce(a.version,n.version) AS output_version,coalesce(a.history_origin,n.history_origin) AS output_origin,
          coalesce(a.created_at,n.created_at) AS output_created_at,
          (coalesce(a.inactive,n.inactive,false) OR coalesce(a.history_stale,n.history_stale,false) OR
            coalesce(a.history_notes_revision,n.history_notes_revision) IS DISTINCT FROM r.notes_revision OR
            coalesce(a.history_transcript_revision,n.history_transcript_revision) IS DISTINCT FROM coalesce(t.transcript_revision,0)) AS output_stale,
          CASE WHEN g.request_key IS NULL THEN NULL
            WHEN g.history_result_status IS NULL THEN CASE WHEN g.expires_at <= statement_timestamp() THEN 'interrupted' ELSE 'pending' END
            WHEN g.history_result_status = 'failed' THEN CASE WHEN g.history_result_code = 'meeting_output_interrupted' THEN 'interrupted' ELSE 'failed' END
            ELSE 'saved' END AS generation_status,
          g.expires_at AS generation_expires_at,
          c.pending_count,c.accepted_count,c.dismissed_count,
          v.artifact_version AS vault_version,v.history_write_status AS vault_write_status,
          v.history_index_status AS vault_index_status,v.history_updated_at AS vault_updated_at,
          saved.saved_count
        FROM records r
        LEFT JOIN LATERAL (
          SELECT transcript_revision,history_sources_json,history_omitted_sources
          FROM app.meeting_transcript_batches WHERE meeting_id=r.id ORDER BY version DESC LIMIT 1
        ) t ON true
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS segment_count,count(*) FILTER (WHERE finality='final')::int AS final_count,
            count(*) FILTER (WHERE finality='provisional')::int AS provisional_count,min(start_ms) AS start_ms,max(end_ms) AS end_ms
          FROM app.meeting_history_segments WHERE meeting_id=r.id
        ) s
        LEFT JOIN LATERAL (
          SELECT version,history_origin,created_at,inactive,history_stale,history_notes_revision,history_transcript_revision
          FROM app.meeting_output_artifacts WHERE meeting_id=r.id AND NOT inactive ORDER BY version DESC LIMIT 1
        ) a ON true
        LEFT JOIN LATERAL (
          SELECT version,history_origin,created_at,inactive,history_stale,history_notes_revision,history_transcript_revision
          FROM app.meeting_output_artifacts WHERE meeting_id=r.id ORDER BY version DESC LIMIT 1
        ) n ON a.version IS NULL
        LEFT JOIN LATERAL (
          SELECT request_key,expires_at,history_result_status,history_result_code
          FROM app.meeting_output_requests WHERE meeting_id=r.id AND history_kind='generate'
          ORDER BY expires_at DESC,request_key DESC LIMIT 1
        ) g ON true
        CROSS JOIN LATERAL (
          SELECT count(*) FILTER (WHERE review_state='pending')::int AS pending_count,
            count(*) FILTER (WHERE review_state='accepted')::int AS accepted_count,
            count(*) FILTER (WHERE review_state='dismissed')::int AS dismissed_count
          FROM app.meeting_action_candidates WHERE meeting_id=r.id
        ) c
        LEFT JOIN LATERAL (
          SELECT artifact_version,history_write_status,history_index_status,history_updated_at
          FROM app.meeting_export_receipts WHERE meeting_id=r.id
          ORDER BY history_updated_at DESC,artifact_version DESC LIMIT 1
        ) v ON true
        CROSS JOIN LATERAL (
          SELECT count(*)::int AS saved_count FROM app.meeting_export_receipts
          WHERE meeting_id=r.id AND history_write_status='saved'
        ) saved
      )
      SELECT * FROM history WHERE ${stateFilter(input.filter)}
      ORDER BY created_at DESC,id DESC LIMIT ${input.limit + 1}
    `.execute(db.db);
    return result.rows;
  }
  async search(
    db: DataContextDb,
    input: SearchMeetingHistoryInput = {}
  ): Promise<MeetingHistoryPage> {
    assertDataContextDb(db);
    const valid = validateMeetingHistoryInput(input);
    try {
      const rows = await this.read(db, valid);
      const meetings = rows.slice(0, valid.limit).map(meetingHistoryItem);
      const last = meetings.at(-1);
      return {
        meetings,
        nextCursor:
          rows.length > valid.limit && last ? { id: last.id, createdAt: last.createdAt } : null
      };
    } catch (error) {
      if (error instanceof MeetingHistoryInputError) throw error;
      throw new MeetingHistoryUnavailableError();
    }
  }
  async get(db: DataContextDb, id: string): Promise<MeetingHistoryItem | null> {
    assertDataContextDb(db);
    if (!isUuid(id)) throw new MeetingHistoryInputError();
    try {
      const rows = await this.read(db, validateMeetingHistoryInput({ limit: 1 }), id);
      return rows[0] ? meetingHistoryItem(rows[0]) : null;
    } catch {
      throw new MeetingHistoryUnavailableError();
    }
  }
}
