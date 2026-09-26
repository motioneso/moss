-- #2682: the nightly purge job (packages/ai/src/jobs.ts, registered by the worker process in
-- apps/worker/src/worker.ts) runs entirely as jarvis_worker_runtime, but EXECUTE on
-- app.purge_moss_action_audit_log has only ever been granted to jarvis_app_runtime (0127,
-- carried through the 0183 rename). The worker has had no way to call it, so the nightly
-- cleanup has failed with permission denied every night.
--
-- The function is SECURITY DEFINER owned by jarvis_migration_owner and already scans/deletes
-- every row regardless of caller (0127's maintenance policies), so the only missing piece is
-- letting the worker role invoke it at all. No table-level DELETE grant and no RLS change is
-- needed or added here — EXECUTE on this one function is the narrowest privilege that makes
-- the cleanup work.

GRANT EXECUTE ON FUNCTION app.purge_moss_action_audit_log(timestamptz) TO jarvis_worker_runtime;
