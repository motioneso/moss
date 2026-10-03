-- #2637 Focus judgments are kept for 30 days (spec 2026-09-20-trail-marker-focus-judgment, section 8).
--
-- The nightly purge (packages/focus-judgment/src/jobs.ts, worked by apps/worker/src/worker.ts)
-- runs as jarvis_worker_runtime. The worker gets no privilege on the table. It may only EXECUTE
-- a no-argument SECURITY DEFINER function owned by jarvis_migration_owner, following the 0245
-- action-audit purge. The function computes its own cutoff, so a caller cannot widen it.
--
-- The table forces row security, and jarvis_migration_owner does not bypass it. The two
-- maintenance policies below carry the same 30-day rule, so the definer can neither see nor
-- delete a recent row even if the function's own filter were wrong.

CREATE POLICY focus_judgments_retention_select ON app.focus_judgments
  FOR SELECT
  TO jarvis_migration_owner
  USING (created_at < now() - interval '30 days');

CREATE POLICY focus_judgments_retention_delete ON app.focus_judgments
  FOR DELETE
  TO jarvis_migration_owner
  USING (created_at < now() - interval '30 days');

CREATE OR REPLACE FUNCTION app.purge_expired_focus_judgments()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM app.focus_judgments WHERE created_at < (now() - interval '30 days');
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_focus_judgments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_focus_judgments() TO jarvis_worker_runtime;
