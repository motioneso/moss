-- Classifier gate, shadow mode (#2868). One row per accepted chat turn that the gate evaluated in
-- shadow: what it would have done, and whether the default model's first tool call agreed.
--
-- Owner-only. There is no admin, thread-sharing or recipient exception on any policy. The row
-- carries the original message text because accuracy review needs it, so it is private data: it
-- never goes to logs, job payloads or PR evidence. Rows expire after 7 days (Ben, 2026-10-01).
-- The app role cannot DELETE; only the no-argument purge function below removes rows.

CREATE TABLE IF NOT EXISTS app.chat_classifier_shadow_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  -- Server-issued turn identifier; the first model tool attempt correlates by this, never by actor.
  turn_id text NOT NULL CHECK (length(btrim(turn_id)) > 0 AND length(turn_id) <= 128),
  message_text text NOT NULL CHECK (octet_length(message_text) <= 2000),
  gate_mode text NOT NULL CHECK (gate_mode = 'shadow'),
  classifier_config_id text NOT NULL CHECK (length(btrim(classifier_config_id)) > 0),
  classifier_config_version text NOT NULL CHECK (length(btrim(classifier_config_version)) > 0),
  threshold_version text NOT NULL CHECK (length(btrim(threshold_version)) > 0),
  -- none, pending, cancelled and failed stay distinct from a hypothetical handled decision.
  decision text NOT NULL DEFAULT 'pending'
    CHECK (decision IN (
      'would_handle', 'declined', 'none', 'needs_earlier_conversation',
      'pending', 'cancelled', 'failed'
    )),
  reason text CHECK (reason IS NULL OR length(reason) <= 64),
  module_id text CHECK (module_id IS NULL OR length(btrim(module_id)) > 0),
  tool_name text CHECK (tool_name IS NULL OR length(btrim(tool_name)) > 0),
  confidence double precision CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  margin double precision CHECK (margin IS NULL OR (margin >= 0 AND margin <= 1)),
  -- Integration tools only: the connection and the reviewed definition the decision relied on.
  connection_id uuid,
  preparation_version text CHECK (preparation_version IS NULL OR length(preparation_version) <= 128),
  risk_version text CHECK (risk_version IS NULL OR length(risk_version) <= 128),
  latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  -- First model tool attempt for the same turn, compared after the fact.
  comparison_status text NOT NULL DEFAULT 'pending'
    CHECK (comparison_status IN (
      'pending', 'match', 'mismatch', 'no_model_tool', 'unobserved', 'cancelled'
    )),
  model_tool_id text CHECK (model_tool_id IS NULL OR length(model_tool_id) <= 256),
  -- Argument agreement is recorded apart from tool-name agreement, and only when it can be
  -- compared safely. Raw argument and result payloads are never stored.
  argument_agreement text
    CHECK (argument_agreement IS NULL OR argument_agreement IN ('match', 'mismatch', 'unavailable')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chat_classifier_shadow_records_turn_unique UNIQUE (owner_user_id, turn_id)
);

CREATE INDEX IF NOT EXISTS chat_classifier_shadow_records_owner_created_idx
  ON app.chat_classifier_shadow_records (owner_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS chat_classifier_shadow_records_created_idx
  ON app.chat_classifier_shadow_records (created_at);

GRANT SELECT, INSERT, UPDATE ON app.chat_classifier_shadow_records TO jarvis_app_runtime;

ALTER TABLE app.chat_classifier_shadow_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_classifier_shadow_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS chat_classifier_shadow_records_select ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_select
ON app.chat_classifier_shadow_records
FOR SELECT TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

DROP POLICY IF EXISTS chat_classifier_shadow_records_insert ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_insert
ON app.chat_classifier_shadow_records
FOR INSERT TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

DROP POLICY IF EXISTS chat_classifier_shadow_records_update ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_update
ON app.chat_classifier_shadow_records
FOR UPDATE TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

-- Maintenance access for the SECURITY DEFINER purge function (runs as jarvis_migration_owner).
DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_select
  ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_maintenance_select
ON app.chat_classifier_shadow_records
FOR SELECT TO jarvis_migration_owner
USING (true);

DROP POLICY IF EXISTS chat_classifier_shadow_records_maintenance_delete
  ON app.chat_classifier_shadow_records;
CREATE POLICY chat_classifier_shadow_records_maintenance_delete
ON app.chat_classifier_shadow_records
FOR DELETE TO jarvis_migration_owner
USING (true);

-- Fixed 7-day retention. The function takes no argument and computes its own cutoff, so a worker
-- connection cannot point it at a wider window (same shape as the #2682 audit-log purge).
CREATE OR REPLACE FUNCTION app.purge_expired_chat_classifier_shadow_records()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM app.chat_classifier_shadow_records
  WHERE created_at < (now() - interval '7 days');
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_chat_classifier_shadow_records() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_chat_classifier_shadow_records()
  TO jarvis_worker_runtime;
