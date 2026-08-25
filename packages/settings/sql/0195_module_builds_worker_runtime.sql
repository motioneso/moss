-- Module builds run in the pg-boss worker process. Keep worker access owner-scoped through the
-- same DataContext actor setting as the app route; no cross-user or admin bypass.
GRANT SELECT, UPDATE ON app.module_builds TO jarvis_worker_runtime;

CREATE POLICY module_builds_worker_select
ON app.module_builds
FOR SELECT
TO jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY module_builds_worker_update
ON app.module_builds
FOR UPDATE
TO jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
