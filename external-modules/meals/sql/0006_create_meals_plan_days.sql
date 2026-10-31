-- Meals S2 (#3886): one row per plan day. generation names the job that owns the day; a job
-- whose generation no longer matches exits without writing (spec correction C1).
CREATE TABLE app.meals_plan_days (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  day_id uuid NOT NULL,
  day_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'writing', 'ready', 'failed')),
  failure_reason text NULL CHECK (failure_reason IN (
    'needs_config', 'provider_error', 'usage_limited', 'validation_failed', 'aborted',
    'safety_cap', 'timeout', 'stopped'
  )),
  cook_time_limit_minutes smallint NULL CHECK (cook_time_limit_minutes BETWEEN 5 AND 240),
  sharing_overrides jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(sharing_overrides) = 'object'),
  generation integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, day_id),
  UNIQUE (owner_user_id, plan_id, day_date),
  FOREIGN KEY (owner_user_id, plan_id)
    REFERENCES app.meals_plans (owner_user_id, plan_id) ON DELETE CASCADE,
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
