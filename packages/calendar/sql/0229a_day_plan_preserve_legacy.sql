-- C2: preserve the pre-0230 values without copying through owner-only RLS.
-- The runner sorts filenames and records text versions, so this new file runs
-- before 0230 on an upgrade, or skips preservation when 0230 already ran.
DO $$
DECLARE
  legacy_columns integer;
BEGIN
  SELECT count(*) INTO legacy_columns
  FROM information_schema.columns
  WHERE table_schema = 'app' AND (
    (table_name = 'day_plans' AND column_name IN ('priority', 'capacity', 'notes')) OR
    (table_name = 'day_plan_blocks' AND column_name IN (
      'placement', 'proposed_placement', 'starts_at', 'ends_at', 'duration_minutes'
    ))
  );

  IF legacy_columns = 0 THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.schema_migrations WHERE version = '0230'
    ) THEN
      RAISE EXCEPTION 'Day-plan preservation requires the complete 0229 or applied 0230 schema';
    END IF;
    RETURN;
  END IF;
  IF legacy_columns <> 8 OR EXISTS (
    SELECT 1 FROM app.schema_migrations WHERE version = '0230'
  ) THEN
    RAISE EXCEPTION 'Partial day-plan legacy schema; preservation aborted';
  END IF;

  ALTER TABLE app.day_plans RENAME COLUMN priority TO legacy_0229_priority;
  ALTER TABLE app.day_plans RENAME COLUMN capacity TO legacy_0229_capacity;
  ALTER TABLE app.day_plans RENAME COLUMN notes TO legacy_0229_notes;
  ALTER TABLE app.day_plans
    ADD COLUMN priority text,
    ADD COLUMN capacity text,
    ADD COLUMN notes text;

  ALTER TABLE app.day_plan_blocks RENAME COLUMN placement TO legacy_0229_placement;
  ALTER TABLE app.day_plan_blocks RENAME COLUMN proposed_placement TO legacy_0229_proposed_placement;
  ALTER TABLE app.day_plan_blocks RENAME COLUMN starts_at TO legacy_0229_starts_at;
  ALTER TABLE app.day_plan_blocks RENAME COLUMN ends_at TO legacy_0229_ends_at;
  ALTER TABLE app.day_plan_blocks RENAME COLUMN duration_minutes TO legacy_0229_duration_minutes;
  -- Later inserts have no legacy state. Retaining the old default would invent it.
  ALTER TABLE app.day_plan_blocks
    DROP CONSTRAINT day_plan_blocks_placement_check,
    DROP CONSTRAINT day_plan_blocks_proposed_placement_check,
    DROP CONSTRAINT day_plan_blocks_duration_minutes_check,
    DROP CONSTRAINT day_plan_blocks_check,
    ALTER COLUMN legacy_0229_placement DROP NOT NULL,
    ALTER COLUMN legacy_0229_placement DROP DEFAULT,
    ADD COLUMN placement text,
    ADD COLUMN proposed_placement text,
    ADD COLUMN starts_at timestamptz,
    ADD COLUMN ends_at timestamptz,
    ADD COLUMN duration_minutes integer;
END;
$$;
