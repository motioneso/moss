-- Store all six medication schedule types and a real per-medication time zone (#1959).
-- Additive-only and re-runnable: every ADD COLUMN / DROP CONSTRAINT uses IF (NOT) EXISTS so it
-- applies cleanly on a fresh database and one that already has medications in it. All new
-- columns are nullable, so existing rows are untouched.

ALTER TABLE app.medications
  ADD COLUMN IF NOT EXISTS schedule_start_date date,
  ADD COLUMN IF NOT EXISTS schedule_end_date date,
  ADD COLUMN IF NOT EXISTS time_zone text,
  ADD COLUMN IF NOT EXISTS interval_unit text,
  ADD COLUMN IF NOT EXISTS interval_count smallint,
  ADD COLUMN IF NOT EXISTS month_kind text,
  ADD COLUMN IF NOT EXISTS month_day smallint,
  ADD COLUMN IF NOT EXISTS month_day_is_last boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS month_weekday_position text,
  ADD COLUMN IF NOT EXISTS month_weekday smallint;

-- Extend the frequency_type discriminator with the two new schedule families. Dropping and
-- re-adding a named CHECK constraint is allowed (only editing an already-applied migration
-- file is forbidden) — same pattern 0083 already established for this table.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_frequency_type_check;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_frequency_type_check CHECK (frequency_type IN
    ('once_daily', 'times_per_day', 'specific_weekdays', 'every_n_hours', 'as_needed',
     'cyclical', 'every_interval', 'monthly'));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_interval_unit_range;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_interval_unit_range
    CHECK (interval_unit IS NULL OR interval_unit IN ('days', 'weeks', 'months'));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_month_kind_range;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_month_kind_range
    CHECK (month_kind IS NULL OR month_kind IN ('date', 'weekdayPosition'));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_month_weekday_position_range;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_month_weekday_position_range
    CHECK (month_weekday_position IS NULL
      OR month_weekday_position IN ('first', 'second', 'third', 'fourth', 'last'));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_month_day_range;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_month_day_range
    CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31);

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_month_weekday_range;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_month_weekday_range
    CHECK (month_weekday IS NULL OR month_weekday BETWEEN 1 AND 7);

-- every_interval: needs its unit, a positive count, a real start date and time zone, and at
-- least one clock time. Weeks additionally needs at least one weekday.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_every_interval_fields_present;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_every_interval_fields_present
    CHECK (frequency_type <> 'every_interval'
      OR (interval_unit IS NOT NULL AND interval_count IS NOT NULL AND interval_count >= 1
          AND schedule_start_date IS NOT NULL AND time_zone IS NOT NULL
          AND schedule_times IS NOT NULL AND array_length(schedule_times, 1) >= 1));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_every_interval_weeks_needs_weekdays;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_every_interval_weeks_needs_weekdays
    CHECK (frequency_type <> 'every_interval' OR interval_unit <> 'weeks'
      OR (weekdays IS NOT NULL AND array_length(weekdays, 1) >= 1));

-- monthly: needs its kind, a real start date and time zone, and at least one clock time. The
-- "date" kind needs exactly one of a numbered day or the explicit last-day-of-month choice,
-- and no weekday-position fields. The "weekdayPosition" kind needs both position fields and no
-- date fields.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_monthly_fields_present;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_monthly_fields_present
    CHECK (frequency_type <> 'monthly'
      OR (month_kind IS NOT NULL AND schedule_start_date IS NOT NULL AND time_zone IS NOT NULL
          AND schedule_times IS NOT NULL AND array_length(schedule_times, 1) >= 1));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_monthly_date_shape;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_monthly_date_shape
    CHECK (frequency_type <> 'monthly' OR month_kind <> 'date'
      OR (((month_day IS NOT NULL) <> (month_day_is_last IS TRUE))
          AND month_weekday_position IS NULL AND month_weekday IS NULL));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_monthly_weekday_position_shape;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_monthly_weekday_position_shape
    CHECK (frequency_type <> 'monthly' OR month_kind <> 'weekdayPosition'
      OR (month_weekday_position IS NOT NULL AND month_weekday IS NOT NULL
          AND month_day IS NULL AND month_day_is_last IS FALSE));

ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_schedule_end_not_before_start;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_schedule_end_not_before_start
    CHECK (schedule_end_date IS NULL OR schedule_start_date IS NULL
      OR schedule_end_date >= schedule_start_date);

-- The new schedule-shape columns only ever apply to the two new frequency types — keeps every
-- other family's rows unambiguous, matching the discriminator pattern from 0083. time_zone is
-- deliberately excluded: every new save, old family or new, now records a real time zone.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_v2_fields_scoped_to_v2_types;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_v2_fields_scoped_to_v2_types
    CHECK (frequency_type IN ('every_interval', 'monthly')
      OR (schedule_start_date IS NULL AND schedule_end_date IS NULL
          AND interval_unit IS NULL AND interval_count IS NULL AND month_kind IS NULL
          AND month_day IS NULL AND month_day_is_last IS FALSE
          AND month_weekday_position IS NULL AND month_weekday IS NULL));
