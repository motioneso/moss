-- Food Phase 1 (#926, #1701): food_meals — one row per logged meal.
-- owner_user_id is the mandatory RLS scoping column; platform generates the
-- FORCE RLS policy from module.manifest.database.ownedTables at install time.
CREATE TABLE app.food_meals (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  meal_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL,
  local_date text NOT NULL,
  timezone_offset integer NOT NULL,
  description text NOT NULL,
  -- The user's own serving qualifier ("a large bowl", "half of it"). Persisted so an
  -- estimate RETRY reproduces the same input as the original attempt; without it a retry
  -- silently estimates a different meal from the one the user described.
  serving_note text,
  capture_kind text NOT NULL,
  estimate_state text NOT NULL,
  estimate_revision integer NOT NULL DEFAULT 0,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, meal_id),
  UNIQUE (owner_user_id, idempotency_key),
  CHECK (capture_kind IN ('text', 'photo', 'voice')),
  CHECK (estimate_state IN ('pending', 'needs_details', 'estimated', 'failed')),
  CHECK (char_length(description) BETWEEN 1 AND 2000),
  CHECK (serving_note IS NULL OR char_length(serving_note) BETWEEN 1 AND 500)
);
