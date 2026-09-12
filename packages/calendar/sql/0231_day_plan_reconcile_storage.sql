-- C2: reconcile only values preserved before 0230. Already-applied 0230
-- installations gain the same nullable legacy columns, not invented history.
ALTER TABLE app.day_plans
  ADD COLUMN IF NOT EXISTS legacy_0229_priority text,
  ADD COLUMN IF NOT EXISTS legacy_0229_capacity text,
  ADD COLUMN IF NOT EXISTS legacy_0229_notes text;
ALTER TABLE app.day_plan_blocks
  ADD COLUMN IF NOT EXISTS legacy_0229_placement text,
  ADD COLUMN IF NOT EXISTS legacy_0229_proposed_placement text,
  ADD COLUMN IF NOT EXISTS legacy_0229_starts_at timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_0229_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS legacy_0229_duration_minutes integer;

-- Follow 0185: the table owner is NOBYPASSRLS. Restore FORCE before the runner
-- commits this transaction; runtime roles receive no additional permissions.
ALTER TABLE app.day_plans NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_blocks NO FORCE ROW LEVEL SECURITY;

UPDATE app.day_plans
SET evening_intent = evening_intent || jsonb_build_object(
  'notes', legacy_0229_notes,
  'capacity', CASE WHEN legacy_0229_capacity IN ('light', 'normal', 'full')
    THEN legacy_0229_capacity ELSE NULL END
)
WHERE legacy_0229_priority IS NOT NULL OR legacy_0229_capacity IS NOT NULL
  OR legacy_0229_notes IS NOT NULL;

-- A single old time pair cannot recover the destination of a pending move.
-- Keep every original field, including unsupported durations and free-text
-- priority, in the owner-scoped legacy columns rather than guessing.
UPDATE app.day_plan_blocks
SET actual_placement = CASE WHEN legacy_0229_placement = 'actual' THEN
    jsonb_build_object(
      'startsAt', to_char(legacy_0229_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'durationMinutes', legacy_0229_duration_minutes,
      'calendarEventRef', NULL
    ) ELSE NULL END,
  pending_change = CASE WHEN legacy_0229_placement = 'proposed'
    AND legacy_0229_proposed_placement IS NULL THEN
    jsonb_build_object(
      'kind', 'add',
      'startsAt', to_char(legacy_0229_starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'durationMinutes', legacy_0229_duration_minutes
    ) ELSE NULL END
WHERE legacy_0229_starts_at IS NOT NULL
  AND legacy_0229_duration_minutes BETWEEN 5 AND 720
  AND (legacy_0229_ends_at IS NULL OR legacy_0229_ends_at =
    legacy_0229_starts_at + make_interval(mins => legacy_0229_duration_minutes));

ALTER TABLE app.day_plans FORCE ROW LEVEL SECURITY;
ALTER TABLE app.day_plan_blocks FORCE ROW LEVEL SECURITY;

-- The operation's plan is already owner-checked. Its block must belong to that
-- same plan; an id-only foreign key accepts a block hidden by row security.
ALTER TABLE app.day_plan_blocks
  ADD CONSTRAINT day_plan_blocks_id_plan_key UNIQUE (id, plan_id);
ALTER TABLE app.day_plan_operations
  DROP CONSTRAINT day_plan_operations_block_id_fkey,
  ADD CONSTRAINT day_plan_operations_block_plan_fkey
    FOREIGN KEY (block_id, plan_id) REFERENCES app.day_plan_blocks(id, plan_id)
    ON DELETE SET NULL (block_id);
