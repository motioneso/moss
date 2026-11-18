-- Phase 0b spike only, not a product migration. A minimal job queue standing in for pg-boss,
-- applied by the bootstrap superuser to the Rust server's clone of the gate database.

CREATE SCHEMA IF NOT EXISTS spike_jobs;

CREATE TABLE IF NOT EXISTS spike_jobs.jobs (
  id uuid PRIMARY KEY,
  queue text NOT NULL,
  data jsonb NOT NULL,
  state text NOT NULL DEFAULT 'created'
    CHECK (state IN ('created', 'active', 'completed', 'failed')),
  output jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS jobs_waiting_idx
  ON spike_jobs.jobs (queue, created_at, id)
  WHERE state = 'created';

-- The app role queues jobs; the worker role claims and finishes them.
GRANT USAGE ON SCHEMA spike_jobs TO jarvis_app_runtime, jarvis_worker_runtime;
GRANT INSERT ON spike_jobs.jobs TO jarvis_app_runtime;
GRANT SELECT, UPDATE ON spike_jobs.jobs TO jarvis_worker_runtime;
