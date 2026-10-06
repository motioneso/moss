-- #3056: the owner acknowledges a notice once per text version, across all browsers/meetings.
CREATE TABLE app.meeting_recording_notices (
  owner_user_id UUID PRIMARY KEY DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  policy_version TEXT NOT NULL CHECK (octet_length(policy_version) BETWEEN 1 AND 80),
  acknowledged_at TIMESTAMPTZ(3) NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE app.meeting_recording_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_notices_owner ON app.meeting_recording_notices
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT, INSERT ON app.meeting_recording_notices TO jarvis_app_runtime;
GRANT UPDATE (policy_version, acknowledged_at) ON app.meeting_recording_notices TO jarvis_app_runtime;
-- Existing grants may still Pause/Stop. Every new Start or Resume binds the current notice.
ALTER TABLE app.meeting_capture_grants
  ADD COLUMN notice_policy_version TEXT CHECK (octet_length(notice_policy_version) BETWEEN 1 AND 80);
GRANT UPDATE (notice_policy_version) ON app.meeting_capture_grants TO jarvis_app_runtime;
-- Ordinary acknowledgement metadata is included in owner exports; no credentials are added.
CREATE POLICY meeting_recording_notices_export_worker ON app.meeting_recording_notices
  FOR SELECT TO jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
GRANT SELECT (owner_user_id,policy_version,acknowledged_at) ON app.meeting_recording_notices TO jarvis_worker_runtime;
GRANT SELECT (notice_policy_version) ON app.meeting_capture_grants TO jarvis_worker_runtime;
