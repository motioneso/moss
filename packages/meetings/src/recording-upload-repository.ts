import { sql } from "kysely";
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { RecordingImportRow } from "./recording-import-repository.js";
import type { parseRecordingUpload } from "./recording-upload-manifest.js";
import type { RecordingSourceKind } from "./recording-source-validation.js";

export interface RecordingChunkRow {
  kind: RecordingSourceKind;
  chunk_index: number;
  byte_length: number;
  sha256: string;
}
export class RecordingUploadRepository {
  async insert(
    db: DataContextDb,
    id: string,
    meetingId: string | null,
    input: ReturnType<typeof parseRecordingUpload>
  ) {
    assertDataContextDb(db);
    const manifest = input.manifest;
    const destination = manifest.destination;
    const metadata = { mode: input.mode, durationMs: input.durationMs, bookmarksMs: [] };
    return (
      await sql<RecordingImportRow>`INSERT INTO app.meeting_recording_imports
      (id,meeting_id,source_device_id,recording_id,fingerprint,metadata_json,voice_enablement_id,source_manifest_json,upload_expires_at)
      VALUES(${id}::uuid,${meetingId}::uuid,${manifest.sourceDeviceId}::uuid,${manifest.recordingId},${input.fingerprint},${JSON.stringify(metadata)},${destination.intent === "voice-request" ? destination.enablementId : null}::uuid,${input.canonical},clock_timestamp()+interval '24 hours') RETURNING *`.execute(
        db.db
      )
    ).rows[0]!;
  }
  async chunks(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    return (
      await sql<RecordingChunkRow>`SELECT kind,chunk_index,byte_length,sha256 FROM app.meeting_recording_chunks WHERE import_id=${id}::uuid ORDER BY kind,chunk_index`.execute(
        db.db
      )
    ).rows;
  }
  async acknowledge(
    db: DataContextDb,
    id: string,
    kind: RecordingSourceKind,
    index: number,
    length: number,
    sha: string
  ) {
    assertDataContextDb(db);
    await sql`INSERT INTO app.meeting_recording_chunks(import_id,kind,chunk_index,byte_length,sha256) VALUES(${id}::uuid,${kind},${index},${length},${sha}) ON CONFLICT DO NOTHING`.execute(
      db.db
    );
  }
  async clearExpired(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    await sql`DELETE FROM app.meeting_recording_chunks WHERE import_id=${id}::uuid`.execute(db.db);
    await sql`UPDATE app.meeting_recording_imports SET upload_reserved=false WHERE id=${id}::uuid AND NOT ready`.execute(
      db.db
    );
  }
  async reserved(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET upload_reserved=true,updated_at=now() WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
  async finalized(
    db: DataContextDb,
    id: string,
    metadata: unknown,
    voice?: { automatic: boolean; capturedAt: string | null }
  ) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET ready=true,metadata_json=${JSON.stringify(metadata)},voice_automatic=${voice?.automatic ?? false},voice_captured_at=${voice?.capturedAt ?? null}::timestamptz,updated_at=now() WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
  async checkpoint(db: DataContextDb, id: string, nextMs: number, version: number, cursor: number) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET next_window_ms=${nextMs},transcript_version=${version},transcript_cursor=${cursor},attempts=0,attempt_id=NULL,state='queued',updated_at=now() WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
  async voiceTranscript(db: DataContextDb, id: string, text: string) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET voice_transcript=${text} WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
}
