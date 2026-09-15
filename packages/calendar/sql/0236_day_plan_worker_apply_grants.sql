-- R2.3-T06: the scheduled briefing worker reserves automatic apply batches.
-- The worker database role holds SELECT on the four day-plan tables today,
-- so it can neither reserve a batch nor record a result. This widens the
-- role to INSERT and UPDATE on exactly those four tables, and admits the
-- worker role to the matching row-security policies with the owner check
-- preserved verbatim (the 0066 calendar-events precedent).

DROP POLICY IF EXISTS day_plans_select ON app.day_plans;
DROP POLICY IF EXISTS day_plans_insert ON app.day_plans;
DROP POLICY IF EXISTS day_plans_update ON app.day_plans;

CREATE POLICY day_plans_select
ON app.day_plans
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plans_insert
ON app.day_plans
FOR INSERT
TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plans_update
ON app.day_plans
FOR UPDATE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE ON app.day_plans TO jarvis_worker_runtime;

DROP POLICY IF EXISTS day_plan_blocks_select ON app.day_plan_blocks;
DROP POLICY IF EXISTS day_plan_blocks_insert ON app.day_plan_blocks;
DROP POLICY IF EXISTS day_plan_blocks_update ON app.day_plan_blocks;

CREATE POLICY day_plan_blocks_select
ON app.day_plan_blocks
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_blocks_insert
ON app.day_plan_blocks
FOR INSERT
TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_blocks_update
ON app.day_plan_blocks
FOR UPDATE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE ON app.day_plan_blocks TO jarvis_worker_runtime;

DROP POLICY IF EXISTS day_plan_operations_select ON app.day_plan_operations;
DROP POLICY IF EXISTS day_plan_operations_insert ON app.day_plan_operations;
DROP POLICY IF EXISTS day_plan_operations_update ON app.day_plan_operations;

CREATE POLICY day_plan_operations_select
ON app.day_plan_operations
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operations_insert
ON app.day_plan_operations
FOR INSERT
TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operations_update
ON app.day_plan_operations
FOR UPDATE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE ON app.day_plan_operations TO jarvis_worker_runtime;

DROP POLICY IF EXISTS day_plan_operation_items_select ON app.day_plan_operation_items;
DROP POLICY IF EXISTS day_plan_operation_items_insert ON app.day_plan_operation_items;
DROP POLICY IF EXISTS day_plan_operation_items_update ON app.day_plan_operation_items;

CREATE POLICY day_plan_operation_items_select
ON app.day_plan_operation_items
FOR SELECT
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operation_items_insert
ON app.day_plan_operation_items
FOR INSERT
TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operation_items_update
ON app.day_plan_operation_items
FOR UPDATE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE ON app.day_plan_operation_items TO jarvis_worker_runtime;
