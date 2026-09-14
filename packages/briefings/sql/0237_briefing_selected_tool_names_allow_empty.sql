-- R3.1-T08: an explicitly empty selected_tool_names list selects no briefing
-- tools, so the installed check must stop requiring a non-empty array. The
-- empty-string element guard stays. The installed constraint name is read from
-- pg_constraint first (expected briefing_definitions_selected_tool_names_check)
-- rather than assumed, then replaced under the same name.
DO $$
DECLARE
  existing_check text;
BEGIN
  SELECT conname INTO existing_check
  FROM pg_constraint
  WHERE conrelid = 'app.briefing_definitions'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%cardinality(selected_tool_names)%'
  LIMIT 1;

  IF existing_check IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app.briefing_definitions DROP CONSTRAINT %I', existing_check);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'app.briefing_definitions'::regclass
      AND conname = 'briefing_definitions_selected_tool_names_check'
  ) THEN
    ALTER TABLE app.briefing_definitions
      ADD CONSTRAINT briefing_definitions_selected_tool_names_check
      CHECK (array_position(selected_tool_names, '') IS NULL);
  END IF;
END
$$;
