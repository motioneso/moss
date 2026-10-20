-- Completed recordings retain provenance without creating a live capture session.
CREATE TABLE app.meeting_recording_imports (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  meeting_id UUID NOT NULL,
  source_device_id UUID NOT NULL,
  recording_id TEXT NOT NULL CHECK (length(recording_id) BETWEEN 1 AND 64),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  metadata_json TEXT NOT NULL CHECK (octet_length(metadata_json) <= 65536),
  ready BOOLEAN NOT NULL DEFAULT false,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','transcribing','complete','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  attempt_id UUID,
  code TEXT CHECK (code IN ('import_interrupted','transcription_unavailable','transcription_failed','import_unavailable')),
  retryable BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(owner_user_id,source_device_id,recording_id),
  FOREIGN KEY(meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_recording_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_imports_owner ON app.meeting_recording_imports
  FOR ALL TO jarvis_app_runtime USING(owner_user_id=app.current_actor_user_id())
  WITH CHECK(owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_recording_imports TO jarvis_app_runtime;
GRANT UPDATE(ready,state,attempts,attempt_id,code,retryable,updated_at) ON app.meeting_recording_imports TO jarvis_app_runtime;
-- Recording import account export: worker reads only the archive projection.
CREATE POLICY meeting_recording_imports_export_worker ON app.meeting_recording_imports
  FOR SELECT TO jarvis_worker_runtime USING(owner_user_id=app.current_actor_user_id());
GRANT SELECT (id, owner_user_id, meeting_id, source_device_id, recording_id, fingerprint, metadata_json, ready, state, attempts, code, created_at)
  ON app.meeting_recording_imports TO jarvis_worker_runtime;
