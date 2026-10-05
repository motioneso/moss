-- moss:backfill 0280_meeting_history.backfill.mjs
-- #2981: current-text search and lightweight metadata. TEXT JSON remains authoritative.
ALTER TABLE app.meeting_records ADD COLUMN history_search_terms TEXT[]
  GENERATED ALWAYS AS (tsvector_to_array(to_tsvector('simple'::regconfig, title || ' ' || personal_notes))) STORED;
CREATE INDEX meeting_records_history_terms ON app.meeting_records USING GIN (history_search_terms);

CREATE TABLE app.meeting_history_segments (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  segment_key TEXT NOT NULL CHECK (octet_length(segment_key) BETWEEN 3 AND 1538),
  revision DOUBLE PRECISION NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991 AND revision = trunc(revision)),
  start_ms DOUBLE PRECISION NOT NULL CHECK (start_ms BETWEEN 0 AND 9007199254740991 AND start_ms = trunc(start_ms)),
  end_ms DOUBLE PRECISION NOT NULL CHECK (end_ms BETWEEN start_ms AND 9007199254740991 AND end_ms = trunc(end_ms)),
  finality TEXT NOT NULL CHECK (finality IN ('provisional', 'final')),
  search_terms TEXT[] NOT NULL,
  PRIMARY KEY (meeting_id, segment_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_history_segments_terms ON app.meeting_history_segments USING GIN (search_terms);
CREATE INDEX meeting_history_segments_owner ON app.meeting_history_segments (owner_user_id, meeting_id);
ALTER TABLE app.meeting_history_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_history_segments FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_history_segments_owner ON app.meeting_history_segments
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT ON app.meeting_history_segments TO jarvis_app_runtime;
GRANT UPDATE (revision, start_ms, end_ms, finality, search_terms)
  ON app.meeting_history_segments TO jarvis_app_runtime;

ALTER TABLE app.meeting_transcript_batches
  ADD COLUMN history_sources_json TEXT NOT NULL DEFAULT '[]' CHECK (octet_length(history_sources_json) <= 8192),
  ADD COLUMN history_omitted_sources INTEGER NOT NULL DEFAULT 0 CHECK (history_omitted_sources BETWEEN 0 AND 128);
ALTER TABLE app.meeting_output_requests
  ADD COLUMN history_kind TEXT,
  ADD COLUMN history_result_status TEXT,
  ADD COLUMN history_result_code TEXT;
CREATE INDEX meeting_output_requests_history_generation
  ON app.meeting_output_requests (meeting_id, expires_at DESC, request_key DESC)
  WHERE history_kind = 'generate';
GRANT UPDATE (history_result_status, history_result_code) ON app.meeting_output_requests TO jarvis_app_runtime;
ALTER TABLE app.meeting_output_artifacts
  ADD COLUMN history_origin TEXT CHECK (history_origin IN ('generated', 'manual')),
  ADD COLUMN history_notes_revision INTEGER,
  ADD COLUMN history_transcript_revision INTEGER,
  ADD COLUMN history_stale BOOLEAN;
CREATE INDEX meeting_output_artifacts_history_head
  ON app.meeting_output_artifacts (meeting_id, version DESC) WHERE NOT inactive;
ALTER TABLE app.meeting_export_receipts
  ADD COLUMN history_write_status TEXT CHECK (history_write_status IN ('pending', 'saved', 'failed', 'conflict')),
  ADD COLUMN history_index_status TEXT CHECK (history_index_status IN ('not-requested', 'queued', 'delayed', 'conflict')),
  ADD COLUMN history_updated_at TEXT;
CREATE INDEX meeting_export_receipts_history_latest
  ON app.meeting_export_receipts (meeting_id, history_updated_at DESC, artifact_version DESC);
GRANT UPDATE (history_write_status, history_index_status, history_updated_at)
  ON app.meeting_export_receipts TO jarvis_app_runtime;

-- Existing first-party migration-owner backfill convention. The declared frozen sidecar
-- restores FORCE before commit. Any exception rolls these DDL changes back atomically.
ALTER TABLE app.meeting_records NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_transcript_batches NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_history_segments NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_output_requests NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_output_artifacts NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_export_receipts NO FORCE ROW LEVEL SECURITY;
