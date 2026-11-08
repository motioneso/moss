-- New Rust-owned ledger. Apply with the migration owner, never a runtime role.
CREATE SCHEMA moss_queue;
REVOKE ALL ON SCHEMA moss_queue FROM PUBLIC;
GRANT USAGE ON SCHEMA moss_queue TO jarvis_app_runtime, jarvis_worker_runtime;
CREATE TABLE moss_queue.jobs (
    id uuid PRIMARY KEY,
    actor_user_id uuid NOT NULL,
    queue text NOT NULL,
    idempotency_key uuid NOT NULL,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 8192),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'completed', 'failed')),
    run_at timestamptz NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    retry_limit integer NOT NULL CHECK (retry_limit BETWEEN 0 AND 100),
    retry_delay_seconds integer NOT NULL CHECK (retry_delay_seconds BETWEEN 0 AND 86400),
    retry_backoff boolean NOT NULL,
    lease_seconds integer NOT NULL CHECK (lease_seconds BETWEEN 1 AND 86400),
    lease_until timestamptz,
    lease_token uuid,
    failure_code text CHECK (failure_code IN ('handler', 'lease-expired', 'invalid-payload')),
    UNIQUE (actor_user_id, queue, idempotency_key)
);
CREATE INDEX jobs_due ON moss_queue.jobs (run_at, id) WHERE state = 'pending';
CREATE TABLE moss_queue.schedules (
    id uuid PRIMARY KEY,
    actor_user_id uuid NOT NULL,
    queue text NOT NULL,
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 8192),
    cron text NOT NULL,
    timezone text NOT NULL,
    next_at timestamptz NOT NULL,
    disabled_reason text CHECK (disabled_reason IN ('invalid-payload', 'invalid-schedule'))
);
ALTER TABLE moss_queue.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_queue.jobs FORCE ROW LEVEL SECURITY;
ALTER TABLE moss_queue.schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_queue.schedules FORCE ROW LEVEL SECURITY;
CREATE POLICY job_actor ON moss_queue.jobs TO jarvis_app_runtime
    USING (actor_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid)
    WITH CHECK (actor_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid);
CREATE POLICY schedule_actor ON moss_queue.schedules TO jarvis_app_runtime
    USING (actor_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid)
    WITH CHECK (actor_user_id = nullif(current_setting('app.actor_user_id', true), '')::uuid);
-- Workers need all queue metadata to claim jobs; resource reads still use the actor's DataContext.
CREATE POLICY job_worker ON moss_queue.jobs TO jarvis_worker_runtime USING (true) WITH CHECK (true);
CREATE POLICY schedule_worker ON moss_queue.schedules TO jarvis_worker_runtime USING (true) WITH CHECK (true);
GRANT SELECT, INSERT ON moss_queue.jobs TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON moss_queue.schedules TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE ON moss_queue.jobs, moss_queue.schedules TO jarvis_worker_runtime;
