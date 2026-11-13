-- The index job stamps indexed_at as the signed-in person. The stamp is the only column the
-- app role may change, and only on that person's own rows.
CREATE POLICY backtrack_segments_update ON app.backtrack_segments
  FOR UPDATE TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id())
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

GRANT UPDATE (indexed_at) ON app.backtrack_segments TO jarvis_app_runtime;
