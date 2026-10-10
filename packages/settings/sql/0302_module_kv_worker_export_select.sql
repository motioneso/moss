-- #3219: the data export runs as the worker role with no module context, so 0157's
-- module-scoped read policy hides every row. The export sets the transaction-local flag
-- app.data_export; with it, the actor's own user rows are readable. Read-only.
CREATE POLICY module_kv_worker_export_select ON app.module_kv
  FOR SELECT TO jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND current_setting('app.data_export', true) = 'on'
    AND app.current_module_id() IS NULL
    AND scope = 'user'
    AND owner_user_id = app.current_actor_user_id()
  );
