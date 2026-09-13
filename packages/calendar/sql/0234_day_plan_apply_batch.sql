-- R2.2-T04A: one durable apply batch per actor, plan and idempotency key.
-- The batch header is an app.day_plan_operations row with kind 'apply' carrying
-- the immutable selection snapshot; app.day_plan_operation_items holds one stable
-- pending record per resolved block. Execution and provider calls belong to later
-- work; this only reserves the batch so a retried request settles once.

-- Batch headers share the operations table; widen its kind check to the header kind.
ALTER TABLE app.day_plan_operations
  DROP CONSTRAINT day_plan_operations_kind_check;
ALTER TABLE app.day_plan_operations
  ADD CONSTRAINT day_plan_operations_kind_check
  CHECK (kind IN ('add', 'move', 'remove', 'apply'));

-- Immutable resolved selection for exact-replay comparison.
ALTER TABLE app.day_plan_operations
  ADD COLUMN IF NOT EXISTS selection_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS app.day_plan_operation_items (
  id uuid PRIMARY KEY,
  operation_id uuid NOT NULL
    REFERENCES app.day_plan_operations(id)
    ON DELETE CASCADE,
  plan_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  block_id uuid,
  kind text NOT NULL CHECK (kind IN ('add', 'move', 'remove')),
  pending_change jsonb NOT NULL,
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'applied', 'failed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, block_id),
  FOREIGN KEY (plan_id, owner_user_id)
    REFERENCES app.day_plans(id, owner_user_id)
    ON DELETE CASCADE
);

-- The item's plan is already owner-checked. Its block must belong to that same
-- plan; an id-only foreign key accepts a block hidden by row security.
ALTER TABLE app.day_plan_operation_items
  DROP CONSTRAINT IF EXISTS day_plan_operation_items_block_plan_fkey;
ALTER TABLE app.day_plan_operation_items
  ADD CONSTRAINT day_plan_operation_items_block_plan_fkey
  FOREIGN KEY (block_id, plan_id) REFERENCES app.day_plan_blocks(id, plan_id)
  ON DELETE SET NULL (block_id);

CREATE INDEX IF NOT EXISTS day_plan_operation_items_operation_idx
  ON app.day_plan_operation_items(operation_id);

ALTER TABLE app.day_plan_operation_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_operation_items FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS day_plan_operation_items_select ON app.day_plan_operation_items;
DROP POLICY IF EXISTS day_plan_operation_items_insert ON app.day_plan_operation_items;
DROP POLICY IF EXISTS day_plan_operation_items_update ON app.day_plan_operation_items;
DROP POLICY IF EXISTS day_plan_operation_items_delete ON app.day_plan_operation_items;

CREATE POLICY day_plan_operation_items_select
ON app.day_plan_operation_items
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operation_items_insert
ON app.day_plan_operation_items
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operation_items_update
ON app.day_plan_operation_items
FOR UPDATE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operation_items_delete
ON app.day_plan_operation_items
FOR DELETE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.day_plan_operation_items TO jarvis_app_runtime;
GRANT SELECT ON app.day_plan_operation_items TO jarvis_worker_runtime;
