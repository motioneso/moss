-- #2682: the nightly purge job (packages/ai/src/jobs.ts, registered by the worker process in
-- apps/worker/src/worker.ts) runs entirely as jarvis_worker_runtime, but EXECUTE on
-- app.purge_moss_action_audit_log(timestamptz) has only ever been granted to jarvis_app_runtime
-- (0127, carried through the 0183 rename). The worker has had no way to call it, so the nightly
-- cleanup has failed with permission denied every night.
--
-- Do NOT grant the worker EXECUTE on the existing function. It accepts an arbitrary cutoff and,
-- as a SECURITY DEFINER running with its owner's maintenance policies, will delete every row
-- older than whatever it's given -- including a caller-supplied 'infinity', which would erase
-- today's rows for every user. The 90-day retention period (packages/ai/src/jobs.ts,
-- packages/ai/src/routes.ts) is not a setting or an environment value today; it's a fixed
-- constant in both places, so the database side below hardcodes the same 90 days rather than
-- inventing a second, different number. There is nothing to clamp against because there is no
-- caller-supplied cutoff at all -- the new function takes no argument and computes its own
-- cutoff from now(), so it can never be pointed at anything wider than that fixed window.
--
-- Instead this adds a second, narrower maintenance function that takes no argument, computes
-- its own 90-day cutoff internally, and is otherwise a copy of the original (same SECURITY
-- DEFINER owner, same pinned search_path, same table). Only this function is granted to the
-- worker; the original stays app-runtime-only, unchanged.

CREATE OR REPLACE FUNCTION app.purge_expired_moss_action_audit_log()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM app.moss_action_audit_log WHERE occurred_at < (now() - interval '90 days');
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_moss_action_audit_log() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_moss_action_audit_log() TO jarvis_worker_runtime;

-- TEMPORARY, FOR CI PROOF ONLY -- reintroduces the reviewed vulnerability (unrestricted-cutoff
-- function reachable by the worker) so the new negative-check test can be observed failing
-- without the real fix, per docs/DEVELOPMENT_STANDARDS.md. Removed in the very next commit.
GRANT EXECUTE ON FUNCTION app.purge_moss_action_audit_log(timestamptz) TO jarvis_worker_runtime;
