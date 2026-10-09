-- #3219: the data export runs as the worker role with an actor but no module context,
-- so 0157's module-scoped read policy hides every row. Allow the actor's own user rows
-- to be read when no module context is set. Read-only; module-scoped access is unchanged.
CREATE POLICY module_kv_worker_export_select ON app.module_kv
  FOR SELECT TO jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND app.current_module_id() IS NULL
    AND scope = 'user'
    AND owner_user_id = app.current_actor_user_id()
  );
