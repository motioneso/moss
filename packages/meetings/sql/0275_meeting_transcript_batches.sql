-- Text-only ingestion receipts. No audio, credentials, or device authorization.
CREATE TABLE app.meeting_transcript_batches (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  version INTEGER NOT NULL CHECK (version BETWEEN 1 AND 4096),
  input_json TEXT NOT NULL CHECK (octet_length(input_json) <= 524288),
  transcript_revision INTEGER NOT NULL CHECK (transcript_revision BETWEEN 0 AND 20000),
  cursor DOUBLE PRECISION NOT NULL CHECK (cursor >= 0 AND cursor <= 9007199254740991 AND cursor = trunc(cursor)),
  stop_cutoff_ms DOUBLE PRECISION CHECK (stop_cutoff_ms >= 0 AND stop_cutoff_ms <= 9007199254740991 AND stop_cutoff_ms = trunc(stop_cutoff_ms)),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, version),
  UNIQUE (meeting_id, request_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_transcript_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_transcript_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_transcript_batches_owner ON app.meeting_transcript_batches
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
-- History cannot be rewritten by the runtime. Deletion cascades from its owning meeting.
GRANT SELECT, INSERT ON app.meeting_transcript_batches TO jarvis_app_runtime;
