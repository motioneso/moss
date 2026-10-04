-- #2956 slice A: owner-owned activity lines, owner detail with 30-day expiry, purge job.
--
-- Bare line (app.moss_model_activity_log) gains the owner, the fixed action vocabulary, the
-- turn/step links, durations, tokens, an allow-listed failure code and numbers-only facts.
-- Owner detail (app.moss_activity_detail) carries the quoted words and step text and expires
-- after 30 days; the bare line stays forever. A daily worker queue calls the purge function.
--
-- Ruling 9: lines recorded before this ships have no owner and must not become System lines,
-- so the table is emptied FIRST, before the new columns and policies land. The detail table
-- is created after the delete, so nothing cascades.

DELETE FROM app.moss_model_activity_log;

ALTER TABLE app.moss_model_activity_log
  ADD COLUMN owner_user_id uuid REFERENCES app.users(id) ON DELETE CASCADE,
  ADD COLUMN action_code text
    CHECK (action_code IS NULL OR (length(btrim(action_code)) > 0 AND length(action_code) <= 64)),
  ADD COLUMN turn_id text
    CHECK (turn_id IS NULL OR (length(btrim(turn_id)) > 0 AND length(turn_id) <= 128)),
  -- Plain uuid, deliberately NO foreign key: the chat answer line is written at turn end,
  -- after its steps, so a FK would force deferred constraints through a fire-and-forget
  -- writer. The list query tolerates a missing parent.
  ADD COLUMN parent_id uuid,
  ADD COLUMN duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  ADD COLUMN input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  ADD COLUMN output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  -- Allow-listed failure vocabulary (spec section 5.4). Raw provider errors can carry
  -- response bodies, so they are never stored; the writer maps to a code.
  ADD COLUMN failure_code text
    CHECK (
      failure_code IS NULL OR failure_code IN (
        'timeout', 'rate_limited', 'auth_failed', 'bad_shape',
        'provider_down', 'cancelled', 'tool_denied', 'unknown'
      )
    ),
  -- Numbers and booleans only, so the bare sub-line survives expiry without keeping words.
  -- A code-level JSON schema admits the same shapes; the trigger below is the second lock.
  -- (A subquery CHECK cannot do this: Postgres forbids subqueries in CHECK constraints.)
  ADD COLUMN fact_counts jsonb
    CHECK (
      fact_counts IS NULL OR (
        jsonb_typeof(fact_counts) = 'object'
        AND pg_column_size(fact_counts) <= 512
      )
    );

-- Rejects any fact_counts value that is not a number or boolean. A trigger, not a CHECK,
-- because the check needs jsonb_each, which CHECK constraints cannot call.
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
    IF entry.key NOT IN ('tools', 'tools_failed', 'jev_agreed', 'confidence') THEN
      RAISE EXCEPTION 'moss_model_activity_log: fact_counts keys are allow-listed (tools, tools_failed, jev_agreed, confidence)';
    END IF;
    IF jsonb_typeof(entry.value) NOT IN ('number', 'boolean') THEN
      RAISE EXCEPTION 'moss_model_activity_log: fact_counts holds numbers and booleans only';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moss_model_activity_log_check_facts ON app.moss_model_activity_log;
CREATE TRIGGER moss_model_activity_log_check_facts
BEFORE INSERT OR UPDATE ON app.moss_model_activity_log
FOR EACH ROW EXECUTE FUNCTION app.moss_model_activity_log_check_facts();

-- Owner-ordered read for the per-user page; partial turn index for the step join.
CREATE INDEX IF NOT EXISTS moss_model_activity_log_owner_time_idx
  ON app.moss_model_activity_log (owner_user_id, occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS moss_model_activity_log_turn_idx
  ON app.moss_model_activity_log (turn_id) WHERE turn_id IS NOT NULL;

-- The admin-wide read policy dies here. Owners read their own lines; admins additionally
-- read ownerless System lines. No policy grants an admin another person's rows.
DROP POLICY IF EXISTS moss_model_activity_log_select ON app.moss_model_activity_log;
CREATE POLICY moss_model_activity_log_select
ON app.moss_model_activity_log
FOR SELECT TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL AND (
    owner_user_id = app.current_actor_user_id()
    OR (owner_user_id IS NULL AND app.current_actor_is_admin())
  )
);

-- A writer may insert a row for the current actor, or an ownerless row (the worker runtime
-- writes with no actor GUC). It may never insert a row owned by someone else.
DROP POLICY IF EXISTS moss_model_activity_log_insert ON app.moss_model_activity_log;
CREATE POLICY moss_model_activity_log_insert
ON app.moss_model_activity_log
FOR INSERT TO jarvis_app_runtime, jarvis_worker_runtime
WITH CHECK (
  owner_user_id IS NULL
  OR (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  )
);

-- Still append-only: no UPDATE/DELETE policy on the bare table.

-- Owner detail: quotes and step words, 30-day expiry. Ownerless lines never get a row here.
CREATE TABLE IF NOT EXISTS app.moss_activity_detail (
  activity_id uuid PRIMARY KEY REFERENCES app.moss_model_activity_log(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  quote text CHECK (quote IS NULL OR octet_length(quote) <= 2000),
  result_line text CHECK (result_line IS NULL OR length(result_line) <= 500),
  steps jsonb NOT NULL
    CHECK (
      jsonb_typeof(steps) = 'array' AND pg_column_size(steps) <= 8192
    ),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS moss_activity_detail_owner_idx
  ON app.moss_activity_detail (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS moss_activity_detail_expires_idx
  ON app.moss_activity_detail (expires_at);

GRANT SELECT, INSERT, UPDATE ON app.moss_activity_detail TO jarvis_app_runtime;

ALTER TABLE app.moss_activity_detail ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.moss_activity_detail FORCE ROW LEVEL SECURITY;

-- Owner-only throughout, same expression shape as the shadow table. No admin policy.
DROP POLICY IF EXISTS moss_activity_detail_select ON app.moss_activity_detail;
CREATE POLICY moss_activity_detail_select
ON app.moss_activity_detail
FOR SELECT TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

DROP POLICY IF EXISTS moss_activity_detail_insert ON app.moss_activity_detail;
CREATE POLICY moss_activity_detail_insert
ON app.moss_activity_detail
FOR INSERT TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

-- UPDATE exists so a late fact can land (Jev agreement settles after the check is
-- recorded). It may not change the owner or the expiry; the trigger below enforces that.
DROP POLICY IF EXISTS moss_activity_detail_update ON app.moss_activity_detail;
CREATE POLICY moss_activity_detail_update
ON app.moss_activity_detail
FOR UPDATE TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE OR REPLACE FUNCTION app.moss_activity_detail_lock_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'moss_activity_detail: owner_user_id and expires_at are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moss_activity_detail_lock_owner ON app.moss_activity_detail;
CREATE TRIGGER moss_activity_detail_lock_owner
BEFORE UPDATE ON app.moss_activity_detail
FOR EACH ROW EXECUTE FUNCTION app.moss_activity_detail_lock_owner();

-- The detail row's owner always equals its line's owner (spec section 5.2). The
-- trigger copies the line's owner onto the row, so a cross-owner attempt fails
-- the owner-only INSERT policy instead of slipping through. A lookup miss fails
-- closed: the row security view can hide another person's line from the inserter,
-- and passing such a row through would plant a detail row the policy then
-- accepts. Ownerless lines never get a detail row. UPDATE needs no sync: the
-- lock trigger above already freezes the owner.
CREATE OR REPLACE FUNCTION app.moss_activity_detail_sync_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  line_owner uuid;
BEGIN
  SELECT owner_user_id INTO line_owner
  FROM app.moss_model_activity_log
  WHERE id = NEW.activity_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'moss_activity_detail: detail rows require an owned line';
  END IF;
  IF line_owner IS NULL THEN
    RAISE EXCEPTION 'moss_activity_detail: ownerless lines never get a detail row';
  END IF;
  NEW.owner_user_id := line_owner;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION app.moss_activity_detail_sync_owner() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.moss_activity_detail_sync_owner() TO jarvis_app_runtime;

DROP TRIGGER IF EXISTS moss_activity_detail_sync_owner ON app.moss_activity_detail;
CREATE TRIGGER moss_activity_detail_sync_owner
BEFORE INSERT ON app.moss_activity_detail
FOR EACH ROW EXECUTE FUNCTION app.moss_activity_detail_sync_owner();

-- Expiry is capped at 30 days after creation: a raw insert cannot keep quoted
-- words forever. UPDATE cannot move expiry (the lock trigger above), so this
-- fires on INSERT only.
CREATE OR REPLACE FUNCTION app.moss_activity_detail_cap_expiry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.expires_at > NEW.created_at + interval '30 days' THEN
    RAISE EXCEPTION 'moss_activity_detail: expires_at is at most 30 days after creation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS moss_activity_detail_cap_expiry ON app.moss_activity_detail;
CREATE TRIGGER moss_activity_detail_cap_expiry
BEFORE INSERT ON app.moss_activity_detail
FOR EACH ROW EXECUTE FUNCTION app.moss_activity_detail_cap_expiry();

-- Maintenance access for the SECURITY DEFINER purge function below (same shape as the
-- 0251 shadow-table purge; 0255 removed that function, this one is new).
DROP POLICY IF EXISTS moss_activity_detail_maintenance_select ON app.moss_activity_detail;
CREATE POLICY moss_activity_detail_maintenance_select
ON app.moss_activity_detail
FOR SELECT TO jarvis_migration_owner
USING (true);

DROP POLICY IF EXISTS moss_activity_detail_maintenance_delete ON app.moss_activity_detail;
CREATE POLICY moss_activity_detail_maintenance_delete
ON app.moss_activity_detail
FOR DELETE TO jarvis_migration_owner
USING (true);

-- Fixed 30-day retention. No arguments, computes its own cutoff, so a worker connection
-- cannot point it at a wider window (same shape as the audit-log purge in 0245).
CREATE OR REPLACE FUNCTION app.purge_expired_moss_activity_detail()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
DECLARE
  affected integer;
BEGIN
  DELETE FROM app.moss_activity_detail
  WHERE expires_at <= now();
  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION app.purge_expired_moss_activity_detail() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.purge_expired_moss_activity_detail()
  TO jarvis_worker_runtime;
