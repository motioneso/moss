-- Recording interpretation is separate from capture and never grants a capture capability.
CREATE TABLE app.meeting_recording_types (
  owner_user_id UUID PRIMARY KEY DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  types_json TEXT NOT NULL CHECK (octet_length(types_json) <= 65536)
);
CREATE TABLE app.meeting_recording_metadata (
  meeting_id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  type_id TEXT CHECK (type_id ~ '^[a-z][a-z0-9-]{0,63}$'),
  type_source TEXT NOT NULL DEFAULT 'automatic' CHECK (type_source IN ('automatic','user')),
  title_source TEXT NOT NULL CHECK (title_source IN ('automatic','user')),
  side TEXT CHECK (side IN ('personal','work')),
  confidence DOUBLE PRECISION CHECK (confidence BETWEEN 0 AND 1),
  reason TEXT CHECK (char_length(reason) <= 1000),
  recorded_at TIMESTAMPTZ(3),
  source TEXT NOT NULL DEFAULT 'recording' CHECK (source IN ('recording','manual-transcript')),
  output_version INTEGER CHECK (output_version > 0),
  FOREIGN KEY (meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_recording_type_filter ON app.meeting_recording_metadata(owner_user_id,type_id,meeting_id);
ALTER TABLE app.meeting_recording_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_types FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_types_owner ON app.meeting_recording_types FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
ALTER TABLE app.meeting_recording_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_metadata FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_metadata_owner ON app.meeting_recording_metadata FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON app.meeting_recording_types TO jarvis_app_runtime;
GRANT SELECT ON app.meeting_recording_types TO jarvis_worker_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.meeting_recording_metadata TO jarvis_app_runtime;
GRANT SELECT,INSERT,UPDATE ON app.meeting_recording_metadata TO jarvis_worker_runtime;

-- Manual input has its own durable admission, independent of capture and ring import.
CREATE TABLE app.meeting_manual_entries (
  meeting_id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  transcript_revision INTEGER NOT NULL CHECK (transcript_revision > 0),
  UNIQUE(owner_user_id,request_key),
  FOREIGN KEY (meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE,
  UNIQUE(meeting_id,owner_user_id)
);
ALTER TABLE app.meeting_manual_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_manual_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_manual_entries_owner ON app.meeting_manual_entries FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_manual_entries TO jarvis_app_runtime;
GRANT SELECT ON app.meeting_manual_entries TO jarvis_worker_runtime;
ALTER TABLE app.meeting_stop_summaries
  ADD COLUMN manual_entry BOOLEAN NOT NULL DEFAULT false,
  DROP CONSTRAINT meeting_automatic_summary_source,
  ADD CONSTRAINT meeting_automatic_summary_source CHECK (
    (grant_id IS NOT NULL AND recording_import_id IS NULL AND transcript_revision IS NULL AND NOT manual_entry) OR
    (grant_id IS NULL AND recording_import_id IS NOT NULL AND transcript_revision IS NOT NULL AND NOT manual_entry) OR
    (grant_id IS NULL AND recording_import_id IS NULL AND transcript_revision IS NOT NULL AND manual_entry)
  );
GRANT SELECT(manual_entry) ON app.meeting_stop_summaries TO jarvis_worker_runtime;
