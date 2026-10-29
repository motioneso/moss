import { getVaultBaseDir, VaultContextRunner, readVaultFile } from "@moss/vault";
import { recordingBundlePath } from "./recording-import-service.js";
import { RecordingUploadRepository } from "./recording-upload-repository.js";
import { readRecordingChunk } from "./recording-upload-storage.js";
import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ModuleLifecycleContext } from "@moss/module-sdk";

type JsonValue = boolean | null | number | string | JsonValue[] | { [key: string]: JsonValue };
type ExportRow = Record<string, JsonValue>;

export interface MeetingsExportSection {
  readonly recording_types: readonly ExportRow[];
  readonly recording_metadata: readonly ExportRow[];
  readonly manual_entries: readonly ExportRow[];
  readonly voice_enablements: readonly ExportRow[];
  readonly recording_imports: readonly ExportRow[];
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
  readonly capture_start_limits: readonly ExportRow[];
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

  const imports = await readRows(
    scopedDb,
    sql<
      Record<string, unknown>
    >`SELECT id::text AS id, owner_user_id::text AS "ownerUserId", meeting_id::text AS "meetingId", source_device_id::text AS "sourceDeviceId", recording_id AS "recordingId", fingerprint, metadata_json AS "metadataJson", ready, state, attempts, code, voice_enablement_id::text AS "voiceEnablementId", voice_automatic AS "voiceAutomatic", voice_captured_at AS "voiceCapturedAt", voice_request_id::text AS "voiceRequestId", source_manifest_json AS "sourceManifestJson",upload_reserved AS "uploadReserved",upload_expires_at AS "uploadExpiresAt",next_window_ms AS "nextWindowMs",transcript_version AS "transcriptVersion",transcript_cursor AS "transcriptCursor",voice_transcript AS "voiceTranscript",created_at AS "createdAt"
      FROM app.meeting_recording_imports
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY created_at, id`
  );
  const vault = new VaultContextRunner(getVaultBaseDir());
  const recordingImports = imports.some((row) => row.ready === true)
    ? await vault.withVaultContext({ actorUserId: ownerUserId }, async (vaultCtx) => {
        for (const row of imports) {
          if (row.ready === true && typeof row.id === "string") {
            if (typeof row.sourceManifestJson === "string") {
              // Read and verify one <=1 MiB chunk at a time. The existing account
              // archive still accumulates JSON in memory (as it does for notes).
              const chunks: JsonValue[] = [];
              for (const chunk of await new RecordingUploadRepository().chunks(scopedDb, row.id)) {
                const bytes = await readRecordingChunk(vaultCtx, row.id, chunk);
                chunks.push({
                  kind: chunk.kind,
                  index: chunk.chunk_index,
                  byteLength: chunk.byte_length,
                  sha256: chunk.sha256,
                  base64: bytes.toString("base64")
                });
              }
              row.chunks = chunks;
            } else row.bundleJson = await readVaultFile(vaultCtx, recordingBundlePath(row.id));
          }
        }
        return imports;
      })
    : imports;
  return {
    recording_types: await readRows(
      scopedDb,
      sql<
        Record<string, unknown>
      >`SELECT owner_user_id::text AS "ownerUserId", revision, types_json AS "typesJson" FROM app.meeting_recording_types WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY owner_user_id`
    ),
    recording_metadata: await readRows(
      scopedDb,
      sql<
        Record<string, unknown>
      >`SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId", revision, type_id AS "typeId", type_source AS "typeSource", title_source AS "titleSource", side, confidence, reason, recorded_at AS "recordedAt", source, output_version AS "outputVersion" FROM app.meeting_recording_metadata WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY meeting_id`
    ),
    manual_entries: await readRows(
      scopedDb,
      sql<
        Record<string, unknown>
      >`SELECT meeting_id::text AS "meetingId", owner_user_id::text AS "ownerUserId", request_key::text AS "requestKey", input_hash AS "inputHash", transcript_revision AS "transcriptRevision" FROM app.meeting_manual_entries WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY meeting_id`
    ),
    voice_enablements: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT id::text AS id,owner_user_id::text AS "ownerUserId",source_device_id::text AS "sourceDeviceId",request_key::text AS "requestKey",inventory_json AS "inventoryJson",enabled_at AS "enabledAt",disabled_at AS "disabledAt"
      FROM app.meeting_recording_voice_enablements
      WHERE owner_user_id = ${ownerUserId}::uuid
      ORDER BY enabled_at, id
    `
    ),
    recording_imports: recordingImports,
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
    capture_start_limits: await readRows(
      scopedDb,
      sql<
        Record<string, unknown>
      >`SELECT owner_user_id::text AS "ownerUserId", started_at AS "startedAt" FROM app.meeting_capture_start_limits WHERE owner_user_id = ${ownerUserId}::uuid ORDER BY owner_user_id`
    ),
    stop_summaries: await readRows(
      scopedDb,
      sql<Record<string, unknown>>`
      SELECT meeting_id::text AS "meetingId",owner_user_id::text AS "ownerUserId",grant_id::text AS "grantId", recording_import_id::text AS "recordingImportId",manual_entry AS "manualEntry",transcript_revision AS "transcriptRevision",request_key::text AS "requestKey",template_id AS "templateId",status,code,due_at AS "dueAt",created_at AS "createdAt",early_enqueued AS "earlyEnqueued",input_json AS "inputJson"
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
