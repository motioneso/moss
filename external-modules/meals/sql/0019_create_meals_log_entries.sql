-- Meals S6 (#3890): one row per logged meal. The log is personal, so rows carry owner_user_id only
-- and never join a Kitchen. estimate_revision starts at 1 because the estimate job's revision
-- parameter is 1 or more.
CREATE TABLE app.meals_log_entries (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  entry_id uuid NOT NULL,
  consumed_at timestamptz NOT NULL,
  local_date text NOT NULL,
  timezone_offset integer NOT NULL,
  description text NOT NULL,
  -- The serving qualifier ("a large bowl"). Kept so an estimate retry sees the original input.
  serving_note text,
  capture_kind text NOT NULL,
  estimate_state text NOT NULL,
  estimate_revision integer NOT NULL DEFAULT 1,
  idempotency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, entry_id),
  UNIQUE (owner_user_id, idempotency_key),
  CHECK (capture_kind IN ('text', 'photo', 'voice')),
  CHECK (estimate_state IN ('pending', 'needs_details', 'estimated', 'failed')),
  CHECK (estimate_revision >= 1),
  CHECK (char_length(description) BETWEEN 1 AND 2000),
  CHECK (serving_note IS NULL OR char_length(serving_note) BETWEEN 1 AND 500)
);
