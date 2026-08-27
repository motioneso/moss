-- Every schedule type can carry a start date, and a reminder on/off flag exists (#1968).
-- Additive-only and re-runnable: the new column uses ADD COLUMN IF NOT EXISTS, and every
-- constraint is dropped by name with IF EXISTS before being re-added, so this applies cleanly to
-- a fresh database and to one that already has medications in it.

-- Reminder on/off. Defaults to false deliberately: no reminder delivery exists yet (the queue in
-- packages/wellness/src/manifest.ts is a designed seam with no worker), so no existing medication
-- should be silently marked as expecting a reminder. The builder form sends an explicit value.
ALTER TABLE app.medications
  ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false;

-- 0194 scoped schedule_start_date and schedule_end_date to the two new schedule families, which
-- made a start date unstorable for daily, selected-days, every-N-hours, cycle and as-needed
-- medications. Narrow the rule to the SHAPE-describing columns only, so the two date columns are
-- available to every frequency type. Dropping and re-adding a named CHECK constraint is allowed
-- (only editing an already-applied migration file is forbidden) — the same pattern 0194 used.
-- medications_schedule_end_not_before_start (added in 0194, already unscoped) still guards
-- ordering for every type.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_v2_fields_scoped_to_v2_types;
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_v2_shape_fields_scoped_to_v2_types;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_v2_shape_fields_scoped_to_v2_types
    CHECK (frequency_type IN ('every_interval', 'monthly')
      OR (interval_unit IS NULL AND interval_count IS NULL AND month_kind IS NULL
          AND month_day IS NULL AND month_day_is_last IS FALSE
          AND month_weekday_position IS NULL AND month_weekday IS NULL));

-- as_needed (PRN) has no scheduled dose time, so there is nothing a reminder could fire on.
-- Matches the way 0083's medications_as_needed_unscheduled keeps as_needed free of every other
-- scheduling field.
ALTER TABLE app.medications
  DROP CONSTRAINT IF EXISTS medications_as_needed_no_reminders;
ALTER TABLE app.medications
  ADD CONSTRAINT medications_as_needed_no_reminders
    CHECK (frequency_type <> 'as_needed' OR reminders_enabled IS FALSE);
