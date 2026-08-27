-- Workflow persistence (#2013, slice 819-B of epic #819).
-- Spec: docs/superpowers/specs/2026-07-08-workflow-layer-pg-boss.md -> "Data Model".
--
-- Status columns are TEXT + CHECK rather than Postgres enum types. Barrier joins and new
-- states are expected in the queue/worker slices (#2014, #2015); a CHECK constraint changes
-- with a plain ALTER, while an enum needs a type migration in a hash-checked file. Both
-- patterns exist in the tree (packages/commitments uses enums, packages/wellness uses
-- checks); this module deliberately picks checks.
--
-- Bounded metadata is enforced here, not just in application code: workflow run and step
-- payloads are metadata by design, and the database is the last line that holds when a
-- future caller forgets. WORKFLOW_MAX_JSON_BYTES in src/types.ts mirrors the 8192 below.

CREATE TABLE app.workflow_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  workflow_id       TEXT NOT NULL CHECK (char_length(workflow_id) <= 200),
  workflow_version  INTEGER NOT NULL,
  module_id         TEXT NOT NULL CHECK (char_length(module_id) <= 200),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'suspended', 'succeeded', 'failed', 'cancelled'
  )),
  started_by        TEXT NOT NULL CHECK (started_by IN ('user', 'module', 'system')),
  input_json        JSONB NOT NULL DEFAULT '{}'::jsonb
                      CHECK (octet_length(input_json::text) <= 8192),
  result_json       JSONB NOT NULL DEFAULT '{}'::jsonb
                      CHECK (octet_length(result_json::text) <= 8192),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_runs_owner_started
  ON app.workflow_runs (owner_user_id, started_at DESC);

ALTER TABLE app.workflow_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_app_runtime ON app.workflow_runs
  AS PERMISSIVE
  FOR ALL
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY workflow_runs_worker_runtime ON app.workflow_runs
  AS PERMISSIVE
  FOR ALL
  TO jarvis_worker_runtime
  USING (true)
  WITH CHECK (true);

GRANT INSERT, SELECT, UPDATE, DELETE ON app.workflow_runs TO jarvis_app_runtime;
GRANT INSERT, SELECT, UPDATE ON app.workflow_runs TO jarvis_worker_runtime;

CREATE TABLE app.workflow_step_runs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id   UUID NOT NULL REFERENCES app.workflow_runs(id) ON DELETE CASCADE,
  owner_user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  step_id           TEXT NOT NULL CHECK (char_length(step_id) <= 200),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'queued', 'running', 'suspended', 'succeeded', 'failed', 'cancelled'
  )),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  input_json        JSONB NOT NULL DEFAULT '{}'::jsonb
                      CHECK (octet_length(input_json::text) <= 8192),
  result_json       JSONB NOT NULL DEFAULT '{}'::jsonb
                      CHECK (octet_length(result_json::text) <= 8192),
  error_code        TEXT CHECK (char_length(error_code) <= 200),
  pgboss_job_id     TEXT CHECK (char_length(pgboss_job_id) <= 200),
  started_at        TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Load-bearing for the queue slice (#2014): a duplicate delivery of the same step job
  -- must collide here rather than execute the step a second time.
  CONSTRAINT uq_workflow_step_run_step UNIQUE (workflow_run_id, step_id)
);

CREATE INDEX idx_workflow_step_runs_run ON app.workflow_step_runs (workflow_run_id);

ALTER TABLE app.workflow_step_runs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_step_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_step_runs_app_runtime ON app.workflow_step_runs
  AS PERMISSIVE
  FOR ALL
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY workflow_step_runs_worker_runtime ON app.workflow_step_runs
  AS PERMISSIVE
  FOR ALL
  TO jarvis_worker_runtime
  USING (true)
  WITH CHECK (true);

GRANT INSERT, SELECT, UPDATE, DELETE ON app.workflow_step_runs TO jarvis_app_runtime;
GRANT INSERT, SELECT, UPDATE ON app.workflow_step_runs TO jarvis_worker_runtime;

CREATE TABLE app.workflow_approvals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id       UUID NOT NULL REFERENCES app.workflow_runs(id) ON DELETE CASCADE,
  step_run_id           UUID NOT NULL REFERENCES app.workflow_step_runs(id) ON DELETE CASCADE,
  owner_user_id         uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'approved', 'denied', 'cancelled'
  )),
  summary               TEXT NOT NULL CHECK (char_length(summary) <= 1000),
  details_json          JSONB NOT NULL DEFAULT '{}'::jsonb
                          CHECK (octet_length(details_json::text) <= 8192),
  resolved_by_user_id   uuid REFERENCES app.users(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_approvals_run ON app.workflow_approvals (workflow_run_id);

ALTER TABLE app.workflow_approvals FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_approvals ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_approvals_app_runtime ON app.workflow_approvals
  AS PERMISSIVE
  FOR ALL
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY workflow_approvals_worker_runtime ON app.workflow_approvals
  AS PERMISSIVE
  FOR ALL
  TO jarvis_worker_runtime
  USING (true)
  WITH CHECK (true);

GRANT INSERT, SELECT, UPDATE, DELETE ON app.workflow_approvals TO jarvis_app_runtime;
GRANT INSERT, SELECT, UPDATE ON app.workflow_approvals TO jarvis_worker_runtime;

-- Reference metadata only. Artifact bytes live in the vault and are written through
-- VaultContext by the later slice (#2015); nothing in this module touches the filesystem.
CREATE TABLE app.workflow_artifacts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_run_id   UUID NOT NULL REFERENCES app.workflow_runs(id) ON DELETE CASCADE,
  step_run_id       UUID REFERENCES app.workflow_step_runs(id) ON DELETE CASCADE,
  owner_user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  artifact_ref      TEXT NOT NULL CHECK (char_length(artifact_ref) <= 1000),
  sha256            TEXT NOT NULL CHECK (char_length(sha256) <= 64),
  content_type      TEXT NOT NULL CHECK (char_length(content_type) <= 200),
  size_bytes        BIGINT NOT NULL CHECK (size_bytes >= 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_artifacts_run ON app.workflow_artifacts (workflow_run_id);

ALTER TABLE app.workflow_artifacts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.workflow_artifacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_artifacts_app_runtime ON app.workflow_artifacts
  AS PERMISSIVE
  FOR ALL
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY workflow_artifacts_worker_runtime ON app.workflow_artifacts
  AS PERMISSIVE
  FOR ALL
  TO jarvis_worker_runtime
  USING (true)
  WITH CHECK (true);

GRANT INSERT, SELECT, UPDATE, DELETE ON app.workflow_artifacts TO jarvis_app_runtime;
GRANT INSERT, SELECT, UPDATE ON app.workflow_artifacts TO jarvis_worker_runtime;
