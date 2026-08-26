-- Workshop module-build jobs install admin-owned drafts from jarvis_worker_runtime. Keep the
-- write narrow: only INSERT/UPDATE, and only while the job's DataContext actor is an active admin.
GRANT INSERT, UPDATE ON app.external_modules TO jarvis_worker_runtime;
GRANT EXECUTE ON FUNCTION app.current_actor_is_admin() TO jarvis_worker_runtime;

DROP POLICY IF EXISTS external_modules_worker_insert ON app.external_modules;
CREATE POLICY external_modules_worker_insert ON app.external_modules
  FOR INSERT TO jarvis_worker_runtime
  WITH CHECK (app.current_actor_is_admin());

DROP POLICY IF EXISTS external_modules_worker_update ON app.external_modules;
CREATE POLICY external_modules_worker_update ON app.external_modules
  FOR UPDATE TO jarvis_worker_runtime
  USING (app.current_actor_is_admin())
  WITH CHECK (app.current_actor_is_admin());
