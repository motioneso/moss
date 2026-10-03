-- #650: the worker is the sole pg-boss supervisor owner (`supervise: true`).
--
-- pg-boss supervision reaps expired active jobs by:
--   - stamping monitor/maintenance fields on pgboss.queue
--   - deleting timed-out rows from pgboss.job, then reinserting retry/failed rows
--
-- Keep this scoped to jarvis_worker_runtime. The API runtime stays supervise:false
-- and must not gain maintenance ownership.

GRANT UPDATE ON pgboss.queue TO jarvis_worker_runtime;
GRANT DELETE ON pgboss.job, pgboss.job_common TO jarvis_worker_runtime;

-- #2911: the worker retires the chat module's dead shadow-record purge queue at startup by
-- calling boss.deleteQueue, which runs the SECURITY INVOKER function pgboss.delete_queue as this
-- role. That function ends with `DELETE FROM pgboss.queue WHERE name = ...`, so the worker needs
-- DELETE on pgboss.queue. Without it pg-boss swallows the permission error and the queue row stays
-- behind while callers believe it was removed. Scoped to jarvis_worker_runtime, the same
-- supervisor ownership as the two grants above; the API runtime stays supervise:false and is
-- untouched.
--
-- Deliberately NOT granted: CREATE on the database. For a partitioned queue the same function also
-- does DROP TABLE, which needs it; every built-in queue here (including the retired purge queue)
-- is non-partitioned, so the plain DELETE path is the one that runs. If a partitioned queue is ever
-- retired this way, add the privilege then rather than widening now.
GRANT DELETE ON pgboss.queue TO jarvis_worker_runtime;
