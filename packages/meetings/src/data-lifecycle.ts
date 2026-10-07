import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };
type ExportRow = Record<string, JsonValue>;

export interface MeetingsExportSection {
  readonly records: readonly ExportRow[];
  readonly note_writes: readonly ExportRow[];
  readonly transcript_batches: readonly ExportRow[];
  readonly output_requests: readonly ExportRow[];
  readonly output_artifacts: readonly ExportRow[];
  readonly action_candidates: readonly ExportRow[];
  readonly export_receipts: readonly ExportRow[];
  readonly export_requests: readonly ExportRow[];
  readonly stop_summaries: readonly ExportRow[];
  readonly capture_grants: readonly ExportRow[];
  readonly capture_connections: readonly ExportRow[];
  readonly capture_start_cancellations: readonly ExportRow[];
}

/**
 * Export retained source rows, including superseded notes, transcripts and outputs. TEXT JSON
 * stays byte-for-byte intact: it can contain evidence and provenance no longer in the current
 * view. Derived history/search projections are omitted. Chat, preferences and accepted Tasks
 * are included elsewhere in account export; this collector reads only Meetings-owned tables. Capture exports include retained state/gaps,
 * never grant verifiers, credential hashes, browser-session IDs, or transient audio.
 */
export async function collectMeetingsExportSection(
  scopedDb: unknown,
  ctx: ModuleLifecycleContext
): Promise<MeetingsExportSection> {
  assertDataContextDb(scopedDb);
  const ownerUserId = ctx.actorUserId;

  return {
    records: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT id::text AS id, owner_user_id::text AS "ownerUserId",
        request_key::text AS "requestKey", title, creation_title AS "creationTitle", personal_notes AS "personalNotes",
        notes_revision AS "notesRevision", created_at AS "createdAt", updated_at AS "updatedAt"
      FROM app.meeting_records
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY created_at, id
    `
    ),
    note_writes: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        request_key::text AS "requestKey", expected_revision AS "expectedRevision",
        personal_notes AS "personalNotes", saved_at AS "savedAt"
      FROM app.meeting_note_writes
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, expected_revision, request_key
    `
    ),
    transcript_batches: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        request_key::text AS "requestKey", version, input_json AS "inputJson",
        transcript_revision AS "transcriptRevision", cursor, stop_cutoff_ms AS "stopCutoffMs",
        created_at AS "createdAt"
      FROM app.meeting_transcript_batches
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, version
    `
    ),
    output_requests: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        request_key::text AS "requestKey", input_json AS "inputJson",
        expires_at AS "expiresAt", result_json AS "resultJson"
      FROM app.meeting_output_requests
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, request_key
    `
    ),
    output_artifacts: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT id::text AS id, meeting_id::text AS "meetingId",
        owner_user_id::text AS "ownerUserId", version, artifact_json AS "artifactJson",
        inactive, created_at AS "createdAt"
      FROM app.meeting_output_artifacts
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, version
    `
    ),
    action_candidates: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT id::text AS id, meeting_id::text AS "meetingId",
        owner_user_id::text AS "ownerUserId", identity_key AS "identityKey",
        artifact_version AS "artifactVersion", proposal_json AS "proposalJson",
        possible_match_ids AS "possibleMatchIds", review_state AS "reviewState",
        accepted_task_id::text AS "acceptedTaskId"
      FROM app.meeting_action_candidates
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, artifact_version, id
    `
    ),
    export_receipts: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        artifact_version AS "artifactVersion", content_hash AS "contentHash",
        receipt_json AS "receiptJson"
      FROM app.meeting_export_receipts
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, artifact_version
    `
    ),
    export_requests: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        request_key::text AS "requestKey", artifact_version AS "artifactVersion",
        result_json AS "resultJson"
      FROM app.meeting_export_requests
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY meeting_id, request_key
    `
    ),
    capture_connections: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT device_id::text AS "deviceId",owner_user_id::text AS "ownerUserId",device_name AS "deviceName",inventory_json AS "inventoryJson",last_seen_at AS "lastSeenAt",expires_at AS "expiresAt"
      FROM app.meeting_capture_connections WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY device_id
    `
    ),
    capture_start_cancellations: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId",owner_user_id::text AS "ownerUserId",request_key::text AS "requestKey",created_at AS "createdAt"
      FROM app.meeting_capture_start_cancellations WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY created_at,request_key
    `
    ),
    stop_summaries: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId",owner_user_id::text AS "ownerUserId",grant_id::text AS "grantId",request_key::text AS "requestKey",template_id AS "templateId",status,code,due_at AS "dueAt",created_at AS "createdAt",early_enqueued AS "earlyEnqueued",input_json AS "inputJson"
      FROM app.meeting_stop_summaries WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY created_at,meeting_id
    `
    ),
    capture_grants: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT id::text AS id, meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId",
        device_name AS "deviceName", status, state_json AS "stateJson",
        created_at AS "createdAt", expires_at AS "expiresAt"
      FROM app.meeting_capture_grants
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY created_at, id
    `
    )
  };
}

async function readRows(
  scopedDb: DataContextDb,
  query: ReturnType<typeof sql<Record<string, unknown>>>
): Promise<ExportRow[]> {
  const result = await query.execute(scopedDb.db);
  return result.rows.map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, normalizeValue(value)]))
  );
}

// Keep export normalization module-owned, like the News and Wellness collectors; importing
// the Settings collector would couple a module's lifecycle to the export orchestration layer.
function normalizeValue(value: unknown): JsonValue {
  if (value instanceof Date) return value.toISOString();
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, normalizeValue(nested)])
    );
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return value;
  }
  return String(value);
}
