-- R2.2-T01 correction: separate actual placement from proposed change, carry
-- the full evening intent as typed JSON, and record idempotent operations.
-- Preserves applied 0229 rows; adds ownership as a database constraint so a
-- child can never reference a hidden foreign plan, even where row security
-- hides that parent.

-- Composite parent key so each child references (plan, owner) together.
ALTER TABLE app.day_plans
  ADD CONSTRAINT day_plans_id_owner_key UNIQUE (id, owner_user_id);

-- Full evening intent as one typed JSON value (migration carries 0229 rows over).
ALTER TABLE app.day_plans
  ADD COLUMN evening_intent jsonb NOT NULL DEFAULT '{"priorityTaskIds":[],"capacity":null,"notes":null,"corrections":[],"commitments":[]}';

UPDATE app.day_plans
SET evening_intent = jsonb_strip_nulls(jsonb_build_object(
  'priorityTaskIds', '[]'::jsonb,
  'capacity', capacity,
  'notes', notes,
  'corrections', '[]'::jsonb,
  'commitments', '[]'::jsonb
));

ALTER TABLE app.day_plans
  DROP COLUMN priority,
  DROP COLUMN capacity,
  DROP COLUMN notes;

-- Blocks carry actual placement apart from the proposed change. Draft saves
-- preserve actual placement; only later application work may change it.
ALTER TABLE app.day_plan_blocks
  ADD COLUMN actual_placement jsonb,
  ADD COLUMN pending_change jsonb;

UPDATE app.day_plan_blocks
SET actual_placement = CASE
  WHEN starts_at IS NULL AND duration_minutes IS NULL THEN NULL
  ELSE jsonb_strip_nulls(jsonb_build_object(
    'startsAt', starts_at,
    'durationMinutes', duration_minutes,
    'calendarEventRef', NULL::text
  ))
END,
pending_change = NULL;

ALTER TABLE app.day_plan_blocks
  DROP COLUMN placement,
  DROP COLUMN proposed_placement,
  DROP COLUMN starts_at,
  DROP COLUMN ends_at,
  DROP COLUMN duration_minutes;

-- The trigger check fails open where row security hides the foreign parent;
-- the composite foreign key below replaces it and cannot be bypassed.
DROP TRIGGER IF EXISTS day_plan_blocks_owner_match ON app.day_plan_blocks;
DROP FUNCTION IF EXISTS app.day_plan_blocks_owner_match();

ALTER TABLE app.day_plan_blocks
  ADD CONSTRAINT day_plan_blocks_plan_owner_fkey
  FOREIGN KEY (plan_id, owner_user_id)
  REFERENCES app.day_plans(id, owner_user_id)
  ON DELETE CASCADE;

-- Idempotent operation slots: one row per actor, plan and idempotency key.
-- No executor or provider call lives here; later work applies these rows.
CREATE TABLE IF NOT EXISTS app.day_plan_operations (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  operation_key text,
  block_id uuid REFERENCES app.day_plan_blocks(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('add', 'move', 'remove')),
  idempotency_key text NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
  expected_revision integer NOT NULL CHECK (expected_revision >= 1),
  outcome text NOT NULL DEFAULT 'pending'
    CHECK (outcome IN ('pending', 'applied', 'failed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, plan_id, idempotency_key),
  FOREIGN KEY (plan_id, owner_user_id)
    REFERENCES app.day_plans(id, owner_user_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS day_plan_operations_plan_idx
  ON app.day_plan_operations(plan_id);

ALTER TABLE app.day_plan_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_operations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS day_plan_operations_select ON app.day_plan_operations;
DROP POLICY IF EXISTS day_plan_operations_insert ON app.day_plan_operations;
DROP POLICY IF EXISTS day_plan_operations_update ON app.day_plan_operations;
DROP POLICY IF EXISTS day_plan_operations_delete ON app.day_plan_operations;

CREATE POLICY day_plan_operations_select
ON app.day_plan_operations
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operations_insert
ON app.day_plan_operations
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_operations_update
ON app.day_plan_operations
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

CREATE POLICY day_plan_operations_delete
ON app.day_plan_operations
FOR DELETE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.day_plan_operations TO jarvis_app_runtime;
GRANT SELECT ON app.day_plan_operations TO jarvis_worker_runtime;
