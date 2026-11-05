-- Raw log store (#3978 slice 2B). Owner-tagged warn-and-above log records, readable only through
-- the admin-checked functions below. No runtime role gets SELECT or DELETE on the table, and no
-- role holds BYPASSRLS. Label lists mirror packages/shared/src/log-labels.ts.

CREATE TABLE IF NOT EXISTS app.diagnostic_log_records (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  process         text NOT NULL CHECK (process IN ('api', 'worker')),
  level           smallint NOT NULL CHECK (level BETWEEN 40 AND 60),
  component       text NOT NULL CHECK (component IN ('api', 'worker', 'auth', 'connectors', 'google-sync', 'oauth', 'email', 'calendar', 'news', 'finance', 'meetings', 'sports', 'jobs', 'ai', 'chat', 'settings', 'vault', 'log', 'other')),
  connection_kind text CHECK (connection_kind IS NULL OR connection_kind IN ('google', 'outlook', 'imap', 'home-assistant', 'calendar', 'news', 'finance', 'meetings', 'sports')),
  event_code      text CHECK (event_code IS NULL OR event_code IN ('auth-failed', 'sync-failed', 'connection-failed', 'timeout', 'helper-unavailable', 'rate-limited', 'job-failed', 'crash', 'startup-failed', 'shutdown-failed', 'log.dropped')),
  owner_user_id   uuid REFERENCES app.users(id) ON DELETE CASCADE,
  message         text NOT NULL CHECK (octet_length(message) <= 2048),
  context         jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(context::text) <= 2048),
  truncated       boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS diagnostic_log_records_time_idx
  ON app.diagnostic_log_records (occurred_at DESC);
CREATE INDEX IF NOT EXISTS diagnostic_log_records_owner_time_idx
  ON app.diagnostic_log_records (owner_user_id, occurred_at DESC) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS diagnostic_log_records_component_idx
  ON app.diagnostic_log_records (component, occurred_at DESC);

ALTER TABLE app.diagnostic_log_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.diagnostic_log_records FORCE ROW LEVEL SECURITY;

-- Both processes write through the worker role. It may insert and nothing else.
DROP POLICY IF EXISTS diagnostic_log_records_insert ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_insert ON app.diagnostic_log_records
  FOR INSERT TO jarvis_worker_runtime WITH CHECK (true);
GRANT INSERT ON app.diagnostic_log_records TO jarvis_worker_runtime;

-- Only the migration owner (the definer functions below) reads and deletes.
DROP POLICY IF EXISTS diagnostic_log_records_definer_select ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_definer_select ON app.diagnostic_log_records
  FOR SELECT TO jarvis_migration_owner USING (true);
DROP POLICY IF EXISTS diagnostic_log_records_definer_delete ON app.diagnostic_log_records;
CREATE POLICY diagnostic_log_records_definer_delete ON app.diagnostic_log_records
  FOR DELETE TO jarvis_migration_owner USING (true);

-- Reader. Returns nothing unless the caller is a live active instance admin. Full text only for
-- the caller's own rows. Other or unknown owners get the allow-listed metadata only.
CREATE OR REPLACE FUNCTION app.read_diagnostic_log(
  p_since timestamptz, p_min_level smallint, p_component text,
  p_connection_kind text, p_limit integer)
RETURNS TABLE(
  occurred_at timestamptz, process text, level smallint, component text,
  connection_kind text, event_code text, owned boolean, owner_known boolean,
  message text, context jsonb, truncated boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT r.occurred_at, r.process, r.level, r.component, r.connection_kind, r.event_code,
         COALESCE(r.owner_user_id = app.current_actor_user_id(), false) AS owned,
         (r.owner_user_id IS NOT NULL) AS owner_known,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() THEN r.message END,
         CASE WHEN r.owner_user_id = app.current_actor_user_id() THEN r.context END,
         r.truncated
  FROM app.diagnostic_log_records r
  WHERE app.current_actor_is_admin()
    AND r.occurred_at >= p_since
    AND r.level >= p_min_level
    AND (p_component IS NULL OR r.component = p_component)
    AND (p_connection_kind IS NULL OR r.connection_kind = p_connection_kind)
  ORDER BY r.occurred_at DESC, r.id DESC
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- Retained window and row count, no content. Same admin gate. A non-admin gets one row of nulls
-- and zero.
CREATE OR REPLACE FUNCTION app.diagnostic_log_coverage()
RETURNS TABLE(oldest_at timestamptz, newest_at timestamptz, row_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = app, pg_temp AS $$
  SELECT min(r.occurred_at), max(r.occurred_at), count(r.id)
  FROM (SELECT 1) one
  LEFT JOIN app.diagnostic_log_records r ON app.current_actor_is_admin();
$$;

-- Purge. Deletes rows older than p_max_age, then the oldest rows beyond p_max_rows, in batches of
-- 5000. Returns the number deleted.
CREATE OR REPLACE FUNCTION app.purge_diagnostic_log(p_max_age interval, p_max_rows integer)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = app, pg_temp AS $$
DECLARE
  v_total integer := 0;
  v_batch integer;
  v_excess bigint;
BEGIN
  LOOP
    DELETE FROM app.diagnostic_log_records
    WHERE id IN (
      SELECT id FROM app.diagnostic_log_records
      WHERE occurred_at < now() - p_max_age
      ORDER BY id LIMIT 5000
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch < 5000;
  END LOOP;

  LOOP
    SELECT count(*) - p_max_rows INTO v_excess FROM app.diagnostic_log_records;
    EXIT WHEN v_excess <= 0;
    DELETE FROM app.diagnostic_log_records
    WHERE id IN (
      SELECT id FROM app.diagnostic_log_records
      ORDER BY occurred_at ASC, id ASC LIMIT LEAST(v_excess, 5000)
    );
    GET DIAGNOSTICS v_batch = ROW_COUNT;
    v_total := v_total + v_batch;
    EXIT WHEN v_batch = 0;
  END LOOP;

  RETURN v_total;
END;
$$;

REVOKE ALL ON FUNCTION app.read_diagnostic_log(timestamptz, smallint, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.diagnostic_log_coverage() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.purge_diagnostic_log(interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.read_diagnostic_log(timestamptz, smallint, text, text, integer)
  TO jarvis_app_runtime;
GRANT EXECUTE ON FUNCTION app.diagnostic_log_coverage() TO jarvis_app_runtime;
GRANT EXECUTE ON FUNCTION app.purge_diagnostic_log(interval, integer) TO jarvis_worker_runtime;
