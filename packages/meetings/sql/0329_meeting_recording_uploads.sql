-- Immutable manifests share the existing owner/source identity with v1/v2 imports.
ALTER TABLE app.meeting_recording_imports
  ADD COLUMN source_manifest_json TEXT CHECK (octet_length(source_manifest_json) <= 4096),
  ADD COLUMN upload_reserved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN upload_expires_at TIMESTAMPTZ,
  ADD COLUMN next_window_ms INTEGER NOT NULL DEFAULT 0 CHECK(next_window_ms BETWEEN 0 AND 7200000),
  ADD COLUMN transcript_version INTEGER NOT NULL DEFAULT 0 CHECK(transcript_version >= 0),
  ADD COLUMN transcript_cursor INTEGER NOT NULL DEFAULT 0 CHECK(transcript_cursor >= 0),
  ADD COLUMN voice_transcript TEXT NOT NULL DEFAULT '' CHECK(octet_length(voice_transcript) <= 131072),
  ADD CONSTRAINT meeting_recording_upload_manifest CHECK ((source_manifest_json IS NULL) = (upload_expires_at IS NULL)),
  ADD CONSTRAINT meeting_recording_import_owner_key UNIQUE(id,owner_user_id);
GRANT UPDATE(metadata_json,upload_reserved,next_window_ms,transcript_version,transcript_cursor,voice_transcript,voice_automatic,voice_captured_at)
  ON app.meeting_recording_imports TO jarvis_app_runtime;
GRANT SELECT(source_manifest_json,upload_reserved,upload_expires_at,next_window_ms,transcript_version,transcript_cursor,voice_transcript)
  ON app.meeting_recording_imports TO jarvis_worker_runtime;

CREATE TABLE app.meeting_recording_chunks (
  import_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('packets','sidecar','wav')),
  chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 255),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 1048576),
  sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY(import_id,kind,chunk_index),
  FOREIGN KEY(import_id,owner_user_id) REFERENCES app.meeting_recording_imports(id,owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_recording_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_chunks FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_chunks_owner ON app.meeting_recording_chunks
  FOR ALL TO jarvis_app_runtime USING(owner_user_id=app.current_actor_user_id())
  WITH CHECK(owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_recording_chunks TO jarvis_app_runtime;
CREATE POLICY meeting_recording_chunks_export_worker ON app.meeting_recording_chunks
  FOR SELECT TO jarvis_worker_runtime USING(owner_user_id=app.current_actor_user_id());
GRANT SELECT ON app.meeting_recording_chunks TO jarvis_worker_runtime;
