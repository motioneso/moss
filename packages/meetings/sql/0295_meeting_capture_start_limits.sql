-- #2981: bounded, owner-scoped rolling Start limits shared across API processes.
CREATE TABLE app.meeting_capture_start_limits (
  owner_user_id UUID PRIMARY KEY DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ(3)[] NOT NULL DEFAULT '{}',
  CONSTRAINT meeting_capture_start_limits_bounded CHECK (
    cardinality(started_at) BETWEEN 0 AND 60 AND array_position(started_at,NULL) IS NULL
  )
);
ALTER TABLE app.meeting_capture_start_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_start_limits FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_start_limits_owner ON app.meeting_capture_start_limits
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT ON app.meeting_capture_start_limits TO jarvis_app_runtime;
GRANT UPDATE (started_at) ON app.meeting_capture_start_limits TO jarvis_app_runtime;
-- Rate-limit history is ordinary owner export metadata. Account deletion cascades from users.
CREATE POLICY meeting_capture_start_limits_export_worker ON app.meeting_capture_start_limits
  FOR SELECT TO jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
GRANT SELECT (owner_user_id,started_at) ON app.meeting_capture_start_limits TO jarvis_worker_runtime;
