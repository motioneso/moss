-- Meals S2 (#3886): one plan per request. The request text is stored here and read inside the
-- day job, so job params carry ids only. state 'stopped' is the Stop flag the job checks before
-- each meal; 'paused' records which enqueue limit stopped the chain.
CREATE TABLE app.meals_plans (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  kitchen_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  start_date date NOT NULL,
  day_count smallint NOT NULL CHECK (day_count BETWEEN 1 AND 28),
  pantry_mode text NOT NULL CHECK (pantry_mode IN ('ignore', 'prefer', 'only')),
  request_text text NULL CHECK (char_length(request_text) <= 1000),
  allow_repeats boolean NOT NULL DEFAULT false,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'stopped', 'paused')),
  paused_reason text NULL CHECK (paused_reason IN ('invocation', 'pending', 'hourly')),
  idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 128),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, plan_id),
  UNIQUE (owner_user_id, idempotency_key),
  FOREIGN KEY (owner_user_id, kitchen_id)
    REFERENCES app.meals_kitchens (owner_user_id, kitchen_id) ON DELETE CASCADE
);
