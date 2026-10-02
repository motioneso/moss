-- Classifier gate, model activity log (plan 3.6a, #2889). One flat row per model call made through
-- a provider adapter: when it happened, what kind of call it was, a short action label, its
-- outcome, the model that ran it, and a short result line.
--
-- Kept indefinitely with no purge job (Ben, 2026-10-01, ruling 14). Rows are append-only: there is
-- no UPDATE or DELETE grant and no policy for either. Every field is a short plain-text value and
-- the table has no column for chat text, prompts, tool arguments or secrets, so a recorded row can
-- never carry private content.
--
-- Row security: only an instance admin may read (SELECT). The runtime writes on the instance's
-- behalf with no actor GUC, so INSERT is permissive for the app and worker runtime roles — the same
-- shape as app.admin_audit_events (0059) and app.jarvis_action_audit_log (0127).

CREATE TABLE IF NOT EXISTS app.moss_model_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind text NOT NULL CHECK (length(btrim(kind)) > 0 AND length(kind) <= 64),
  action text NOT NULL CHECK (length(btrim(action)) > 0 AND length(action) <= 200),
  outcome text NOT NULL CHECK (length(btrim(outcome)) > 0 AND length(outcome) <= 64),
  model_name text NOT NULL CHECK (length(btrim(model_name)) > 0 AND length(model_name) <= 200),
  result text NOT NULL CHECK (length(result) <= 500)
);

-- Time-ordered read with a stable (occurred_at, id) cursor for paging by time.
CREATE INDEX IF NOT EXISTS moss_model_activity_log_time_idx
  ON app.moss_model_activity_log (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS moss_model_activity_log_kind_time_idx
  ON app.moss_model_activity_log (kind, occurred_at DESC);

CREATE INDEX IF NOT EXISTS moss_model_activity_log_model_time_idx
  ON app.moss_model_activity_log (model_name, occurred_at DESC);

CREATE INDEX IF NOT EXISTS moss_model_activity_log_result_time_idx
  ON app.moss_model_activity_log (outcome, occurred_at DESC);

GRANT SELECT, INSERT ON app.moss_model_activity_log TO jarvis_app_runtime;
GRANT INSERT ON app.moss_model_activity_log TO jarvis_worker_runtime;

ALTER TABLE app.moss_model_activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.moss_model_activity_log FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS moss_model_activity_log_select ON app.moss_model_activity_log;
CREATE POLICY moss_model_activity_log_select
ON app.moss_model_activity_log
FOR SELECT TO jarvis_app_runtime
USING (app.current_actor_is_admin());

DROP POLICY IF EXISTS moss_model_activity_log_insert ON app.moss_model_activity_log;
CREATE POLICY moss_model_activity_log_insert
ON app.moss_model_activity_log
FOR INSERT TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (true);

-- No UPDATE/DELETE policy: the log is append-only and kept forever.
