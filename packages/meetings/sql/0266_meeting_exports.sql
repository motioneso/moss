-- Receipts are meeting-owned metadata. Exported Notes files have independent lifecycles.
CREATE TABLE app.meeting_export_receipts (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  artifact_version INTEGER NOT NULL CHECK (artifact_version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  receipt_json TEXT NOT NULL CHECK (octet_length(receipt_json) <= 16384),
  PRIMARY KEY (meeting_id, artifact_version),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, artifact_version) REFERENCES app.meeting_output_artifacts(meeting_id, version) ON DELETE CASCADE
);
CREATE TABLE app.meeting_export_requests (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  artifact_version INTEGER NOT NULL,
  result_json TEXT CHECK (octet_length(result_json) <= 16384),
  PRIMARY KEY (meeting_id, request_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, artifact_version) REFERENCES app.meeting_export_receipts(meeting_id, artifact_version) ON DELETE CASCADE
);
ALTER TABLE app.meeting_export_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_export_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_export_receipts_owner ON app.meeting_export_receipts FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id());
ALTER TABLE app.meeting_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_export_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_export_requests_owner ON app.meeting_export_requests FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT ON app.meeting_export_receipts, app.meeting_export_requests TO jarvis_app_runtime;
GRANT UPDATE (receipt_json) ON app.meeting_export_receipts TO jarvis_app_runtime;
GRANT UPDATE (result_json) ON app.meeting_export_requests TO jarvis_app_runtime;
