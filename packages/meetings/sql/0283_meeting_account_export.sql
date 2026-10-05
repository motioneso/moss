-- Full-account export reads retained Meetings source rows under the requesting owner's actor.
-- Explicit column grants exclude derived history/search projections and future added columns.
CREATE POLICY meeting_records_export_worker ON app.meeting_records
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (id, owner_user_id, request_key, title, personal_notes, notes_revision, created_at, updated_at)
  ON app.meeting_records TO jarvis_worker_runtime;

CREATE POLICY meeting_note_writes_export_worker ON app.meeting_note_writes
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, request_key, expected_revision, personal_notes, saved_at)
  ON app.meeting_note_writes TO jarvis_worker_runtime;

CREATE POLICY meeting_transcript_batches_export_worker ON app.meeting_transcript_batches
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, request_key, version, input_json, transcript_revision, cursor, stop_cutoff_ms, created_at)
  ON app.meeting_transcript_batches TO jarvis_worker_runtime;

CREATE POLICY meeting_output_requests_export_worker ON app.meeting_output_requests
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, request_key, input_json, expires_at, result_json)
  ON app.meeting_output_requests TO jarvis_worker_runtime;

CREATE POLICY meeting_output_artifacts_export_worker ON app.meeting_output_artifacts
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (id, meeting_id, owner_user_id, version, artifact_json, inactive, created_at)
  ON app.meeting_output_artifacts TO jarvis_worker_runtime;

CREATE POLICY meeting_action_candidates_export_worker ON app.meeting_action_candidates
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (id, meeting_id, owner_user_id, identity_key, artifact_version, proposal_json, possible_match_ids, review_state, accepted_task_id)
  ON app.meeting_action_candidates TO jarvis_worker_runtime;

CREATE POLICY meeting_export_receipts_export_worker ON app.meeting_export_receipts
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, artifact_version, content_hash, receipt_json)
  ON app.meeting_export_receipts TO jarvis_worker_runtime;

CREATE POLICY meeting_export_requests_export_worker ON app.meeting_export_requests
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, request_key, artifact_version, result_json)
  ON app.meeting_export_requests TO jarvis_worker_runtime;
