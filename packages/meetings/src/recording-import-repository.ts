import { sql } from "kysely";
import { assertDataContextDb, assertUuid, type DataContextDb } from "@moss/db";
import type { MeetingRecordingImportStatus, VoiceRecordingImportStatus } from "@moss/shared";
import type { RecordingBundle } from "./recording-bundle.js";

export interface RecordingImportRow {
  id: string;
  meeting_id: string | null;
  voice_enablement_id: string | null;
  voice_automatic: boolean;
  voice_captured_at: Date | null;
  voice_request_id: string | null;
  fingerprint: string;
  metadata_json: string;
  ready: boolean;
  state: MeetingRecordingImportStatus["state"];
  attempts: number;
  attempt_id: string | null;
  code: MeetingRecordingImportStatus["code"];
  retryable: boolean;
}
export class RecordingImportConflictError extends Error {}
export function recordingImportStatus(row: RecordingImportRow): MeetingRecordingImportStatus {
  if (!row.meeting_id) throw new Error("Voice recording has no meeting destination");
  const metadata = JSON.parse(row.metadata_json) as Pick<
    MeetingRecordingImportStatus,
    "mode" | "durationMs" | "bookmarksMs"
  >;
  return {
    id: row.id,
    meetingId: row.meeting_id,
    state: row.state,
    mode: metadata.mode,
    durationMs: metadata.durationMs,
    bookmarksMs: metadata.bookmarksMs,
    code: row.code,
    retryable: row.retryable
  };
}
export function voiceRecordingImportStatus(row: RecordingImportRow): VoiceRecordingImportStatus {
  return {
    id: row.id,
    state: row.state,
    intent: "voice-request",
    voiceRequestId: row.voice_request_id,
    code: row.code,
    retryable: row.retryable
  };
}
export class RecordingImportRepository {
  async lockIdentity(db: DataContextDb, sourceDeviceId: string, recordingId: string) {
    assertDataContextDb(db);
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id') || ${sourceDeviceId} || ${recordingId},0))`.execute(
      db.db
    );
    return (
      (
        await sql<RecordingImportRow>`SELECT * FROM app.meeting_recording_imports WHERE source_device_id=${sourceDeviceId}::uuid AND recording_id=${recordingId} FOR UPDATE`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async get(db: DataContextDb, id: string, lock = false) {
    assertDataContextDb(db);
    assertUuid(id, "Recording import id");
    return (
      (
        await sql<RecordingImportRow>`SELECT * FROM app.meeting_recording_imports WHERE id=${id}::uuid ${lock ? sql`FOR UPDATE` : sql``}`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async insert(
    db: DataContextDb,
    id: string,
    meetingId: string | null,
    bundle: RecordingBundle,
    voice?: { enablementId: string; automatic: boolean; capturedAt: string | null }
  ) {
    assertDataContextDb(db);
    const { manifest } = bundle;
    const metadata = {
      mode: bundle.mode,
      durationMs: bundle.durationMs,
      startMs: bundle.startMs,
      endMs: bundle.endMs,
      recordedDurationMs: bundle.recordedDurationMs,
      bookmarksMs: bundle.bookmarksMs
    };
    const value = {
      ...metadata,
      packets: { name: manifest.packets.name, sha256: manifest.packets.sha256 },
      sidecar: { name: manifest.sidecar.name, sha256: manifest.sidecar.sha256 },
      wav: { name: manifest.wav.name, sha256: manifest.wav.sha256 }
    };
    return (
      await sql<RecordingImportRow>`INSERT INTO app.meeting_recording_imports(id,meeting_id,source_device_id,recording_id,fingerprint,metadata_json,voice_enablement_id,voice_automatic,voice_captured_at) VALUES(${id}::uuid,${meetingId}::uuid,${manifest.sourceDeviceId}::uuid,${manifest.recordingId},${bundle.fingerprint},${JSON.stringify(value)},${voice?.enablementId ?? null}::uuid,${voice?.automatic ?? false},${voice?.capturedAt ?? null}::timestamptz) RETURNING *`.execute(
        db.db
      )
    ).rows[0]!;
  }
  async retryVoice(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET state='queued',attempts=0,attempt_id=NULL,code=NULL,retryable=false,updated_at=now() WHERE id=${id}::uuid AND meeting_id IS NULL AND state='failed' AND ready`.execute(
      db.db
    );
  }
  async completeVoice(db: DataContextDb, id: string, requestId: string) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET state='complete',code=NULL,retryable=false,voice_request_id=${requestId}::uuid,updated_at=now() WHERE id=${id}::uuid AND meeting_id IS NULL`.execute(
      db.db
    );
  }
  async ready(db: DataContextDb, id: string) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET ready=true,updated_at=now() WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
  async claim(db: DataContextDb, id: string, attemptId: string) {
    assertDataContextDb(db);
    return (
      (
        await sql<RecordingImportRow>`UPDATE app.meeting_recording_imports SET state='transcribing',attempts=attempts+1,attempt_id=${attemptId}::uuid,code=NULL,retryable=false,updated_at=now() WHERE id=${id}::uuid AND ready AND state IN ('queued','transcribing') AND attempts<3 RETURNING *`.execute(
          db.db
        )
      ).rows[0] ?? null
    );
  }
  async finish(
    db: DataContextDb,
    id: string,
    state: RecordingImportRow["state"],
    code: RecordingImportRow["code"],
    retryable = false
  ) {
    assertDataContextDb(db);
    await sql`UPDATE app.meeting_recording_imports SET state=${state},code=${code},retryable=${retryable},updated_at=now() WHERE id=${id}::uuid`.execute(
      db.db
    );
  }
  async forMeeting(db: DataContextDb, meetingId: string) {
    assertDataContextDb(db);
    return (
      await sql<{
        id: string;
      }>`SELECT id FROM app.meeting_recording_imports WHERE meeting_id=${meetingId}::uuid`.execute(
        db.db
      )
    ).rows;
  }
}
