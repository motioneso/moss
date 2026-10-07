-- moss:backfill 0292_meeting_minimal.backfill.mjs
-- Preserve creation request replay while permitting separately concurrency-checked title edits.
ALTER TABLE app.meeting_records ADD COLUMN creation_title TEXT;
ALTER TABLE app.meeting_records DISABLE ROW LEVEL SECURITY;
UPDATE app.meeting_records SET creation_title=title;
ALTER TABLE app.meeting_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_records FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_records ALTER COLUMN creation_title SET NOT NULL;
CREATE FUNCTION app.meeting_record_creation_title() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.creation_title := NEW.title; RETURN NEW; END $$;
CREATE TRIGGER meeting_record_creation_title BEFORE INSERT ON app.meeting_records
  FOR EACH ROW EXECUTE FUNCTION app.meeting_record_creation_title();
GRANT UPDATE (title) ON app.meeting_records TO jarvis_app_runtime;
GRANT SELECT (creation_title) ON app.meeting_records TO jarvis_worker_runtime;
ALTER TABLE app.meeting_capture_start_cancellations ALTER COLUMN device_id DROP NOT NULL, ALTER COLUMN connection_id DROP NOT NULL;
ALTER TABLE app.meeting_capture_grants ADD COLUMN recorded_duration_ms INTEGER CHECK (recorded_duration_ms BETWEEN 0 AND 7200000);
GRANT UPDATE (recorded_duration_ms) ON app.meeting_capture_grants TO jarvis_app_runtime;
ALTER TABLE app.meeting_output_artifacts ADD COLUMN history_overview TEXT NOT NULL DEFAULT '' CHECK (char_length(history_overview)<=240);

-- Exactly one automatic attempt per meeting. No prompts, transcript text or credentials.
CREATE TABLE app.meeting_stop_summaries (
  meeting_id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  grant_id UUID NOT NULL,
  request_key UUID NOT NULL,
  template_id TEXT NOT NULL CHECK (template_id IN ('general','one-to-one','project-review','interview')),
  status TEXT NOT NULL CHECK (status IN ('waiting','submitted','skipped')),
  code TEXT,
  due_at TIMESTAMPTZ(3) NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp(),
  early_enqueued BOOLEAN NOT NULL DEFAULT false,
  input_json TEXT CHECK (octet_length(input_json)<=2048),
  FOREIGN KEY (meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (grant_id,owner_user_id) REFERENCES app.meeting_capture_grants(id,owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_stop_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_stop_summaries FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_stop_summaries_owner ON app.meeting_stop_summaries FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT ON app.meeting_stop_summaries TO jarvis_app_runtime;
GRANT UPDATE (early_enqueued,status,code) ON app.meeting_stop_summaries TO jarvis_app_runtime;
GRANT SELECT (meeting_id,owner_user_id,grant_id,request_key,template_id,status,code,due_at,created_at,early_enqueued,input_json)
  ON app.meeting_stop_summaries TO jarvis_worker_runtime;
GRANT UPDATE (status,code,input_json) ON app.meeting_stop_summaries TO jarvis_worker_runtime;

-- The canonical worker may reserve/save summaries under the owner's RLS. It cannot write capture
-- state, change capability bindings, accept action candidates, or read capture credentials.
CREATE POLICY meeting_records_summary_worker ON app.meeting_records FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT UPDATE (title,updated_at) ON app.meeting_records TO jarvis_worker_runtime;
CREATE POLICY meeting_output_requests_summary_worker ON app.meeting_output_requests FOR INSERT TO jarvis_worker_runtime WITH CHECK (owner_user_id=app.current_actor_user_id());
CREATE POLICY meeting_output_requests_summary_result ON app.meeting_output_requests FOR UPDATE TO jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT INSERT (meeting_id,request_key,input_json,result_json,history_kind,history_result_status,history_result_code) ON app.meeting_output_requests TO jarvis_worker_runtime;
GRANT SELECT (history_kind,history_result_status,history_result_code) ON app.meeting_output_requests TO jarvis_worker_runtime;
GRANT UPDATE (result_json,history_result_status,history_result_code) ON app.meeting_output_requests TO jarvis_worker_runtime;
CREATE POLICY meeting_output_artifacts_summary_worker ON app.meeting_output_artifacts FOR INSERT TO jarvis_worker_runtime WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT INSERT (id,meeting_id,version,artifact_json,inactive,history_origin,history_notes_revision,history_transcript_revision,history_stale,history_overview) ON app.meeting_output_artifacts TO jarvis_worker_runtime;
CREATE POLICY meeting_action_candidates_summary_worker ON app.meeting_action_candidates FOR INSERT TO jarvis_worker_runtime WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT INSERT (meeting_id,identity_key,artifact_version,proposal_json,possible_match_ids) ON app.meeting_action_candidates TO jarvis_worker_runtime;
