-- R2.2-T01: one Calendar-owned saved plan per actor and local day.
-- Plans keep evening intent and typed blocks as execution reservations;
-- canonical task identity, status and dates stay in app.tasks.

CREATE TABLE IF NOT EXISTS app.day_plans (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  local_day date NOT NULL,
  time_zone text NOT NULL CHECK (length(btrim(time_zone)) > 0),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  priority text,
  capacity text,
  notes text,
  source_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, local_day, time_zone)
);

CREATE TABLE IF NOT EXISTS app.day_plan_blocks (
  id uuid PRIMARY KEY,
  plan_id uuid NOT NULL REFERENCES app.day_plans(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES app.tasks(id) ON DELETE SET NULL,
  kind text NOT NULL CHECK (kind IN ('focus', 'meeting', 'prep', 'break', 'personal', 'unscheduled')),
  placement text NOT NULL DEFAULT 'actual' CHECK (placement IN ('actual', 'proposed')),
  proposed_placement text CHECK (proposed_placement IN ('actual', 'proposed')),
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  duration_minutes integer CHECK (duration_minutes IS NULL OR (duration_minutes >= 5 AND duration_minutes <= 1440)),
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS day_plans_owner_day_idx
  ON app.day_plans(owner_user_id, local_day);
CREATE INDEX IF NOT EXISTS day_plan_blocks_plan_idx
  ON app.day_plan_blocks(plan_id);

CREATE OR REPLACE FUNCTION app.day_plan_blocks_owner_match()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.day_plans plan
    WHERE plan.id = NEW.plan_id AND plan.owner_user_id <> NEW.owner_user_id
  ) THEN
    RAISE EXCEPTION 'day plan block owner must match its plan owner';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS day_plan_blocks_owner_match ON app.day_plan_blocks;

CREATE TRIGGER day_plan_blocks_owner_match
BEFORE INSERT OR UPDATE OF plan_id, owner_user_id ON app.day_plan_blocks
FOR EACH ROW
EXECUTE FUNCTION app.day_plan_blocks_owner_match();

ALTER TABLE app.day_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.day_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_blocks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS day_plans_select ON app.day_plans;
DROP POLICY IF EXISTS day_plans_insert ON app.day_plans;
DROP POLICY IF EXISTS day_plans_update ON app.day_plans;
DROP POLICY IF EXISTS day_plans_delete ON app.day_plans;

CREATE POLICY day_plans_select
ON app.day_plans
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plans_insert
ON app.day_plans
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plans_update
ON app.day_plans
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

CREATE POLICY day_plans_delete
ON app.day_plans
FOR DELETE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

DROP POLICY IF EXISTS day_plan_blocks_select ON app.day_plan_blocks;
DROP POLICY IF EXISTS day_plan_blocks_insert ON app.day_plan_blocks;
DROP POLICY IF EXISTS day_plan_blocks_update ON app.day_plan_blocks;
DROP POLICY IF EXISTS day_plan_blocks_delete ON app.day_plan_blocks;

CREATE POLICY day_plan_blocks_select
ON app.day_plan_blocks
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_blocks_insert
ON app.day_plan_blocks
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY day_plan_blocks_update
ON app.day_plan_blocks
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

CREATE POLICY day_plan_blocks_delete
ON app.day_plan_blocks
FOR DELETE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.day_plans TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.day_plan_blocks TO jarvis_app_runtime;
GRANT SELECT ON app.day_plans TO jarvis_worker_runtime;
GRANT SELECT ON app.day_plan_blocks TO jarvis_worker_runtime;
