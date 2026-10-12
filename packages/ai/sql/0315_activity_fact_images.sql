-- #3067: a Trail Marker judgment can carry one screenshot. Its activity line records how many
-- pictures the call carried, as the allow-listed fact `images` (a count, 0 or 1). The picture
-- itself never reaches this table.
--
-- Replaces 0258's trigger function with `images` added to the key list; the rest of the body is
-- unchanged. The trigger itself still points at this function, so it is not recreated.

CREATE OR REPLACE FUNCTION app.moss_model_activity_log_check_facts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  entry record;
BEGIN
  IF NEW.fact_counts IS NULL THEN
    RETURN NEW;
  END IF;
  FOR entry IN SELECT * FROM jsonb_each(NEW.fact_counts) LOOP
    -- Allow-listed key names (spec section 5.1 example). Free-text keys would stay on
    -- the bare line forever, so anything outside the vocabulary fails the write.
    IF entry.key NOT IN ('tools', 'tools_failed', 'jev_agreed', 'confidence', 'images') THEN
      RAISE EXCEPTION 'moss_model_activity_log: fact_counts keys are allow-listed (tools, tools_failed, jev_agreed, confidence, images)';
    END IF;
    IF jsonb_typeof(entry.value) NOT IN ('number', 'boolean') THEN
      RAISE EXCEPTION 'moss_model_activity_log: fact_counts holds numbers and booleans only';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
