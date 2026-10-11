-- The worker role reads the actor's own per-user module deny rows.
DROP POLICY IF EXISTS module_enablement_user_select_worker ON app.module_enablement;

CREATE POLICY module_enablement_user_select_worker ON app.module_enablement
  FOR SELECT TO jarvis_worker_runtime
  USING (
    scope = 'user'
    AND app.current_actor_user_id() IS NOT NULL
    AND user_id = app.current_actor_user_id()
  );
