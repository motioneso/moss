-- Moss heartbeat storage (#3752): owner settings, per-source change checkpoints, check history,
-- findings, muted topics and the daily generation allowance ledger. Every table is owner-only
-- under FORCE RLS and cascades away with its user.

CREATE TABLE app.heartbeat_settings (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  enabled boolean NOT NULL,
  cadence_minutes smallint NOT NULL CHECK (cadence_minutes IN (30, 60)),
  sources jsonb NOT NULL,
  origin text NOT NULL CHECK (origin IN ('default', 'saved', 'legacy_off')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  next_due_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.heartbeat_source_checkpoints (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('calendar', 'tasks', 'memory', 'sports', 'news')),
  revision text NOT NULL,
  next_boundary_at timestamptz,
  evaluated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, source)
);

CREATE TABLE app.heartbeat_occurrences (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  settings_revision integer NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text NOT NULL CHECK (
    outcome IN ('running', 'quiet', 'message', 'held_allowance', 'degraded', 'failed')
  ),
  item_count smallint NOT NULL DEFAULT 0,
  message_id uuid,
  input_tokens integer,
  output_tokens integer
);
CREATE INDEX heartbeat_occurrences_owner_started
  ON app.heartbeat_occurrences (owner_user_id, started_at DESC);

CREATE TABLE app.heartbeat_findings (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('calendar', 'tasks', 'memory', 'sports', 'news')),
  entity_key text NOT NULL,
  episode_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('selected', 'published', 'resolved', 'suppressed')),
  occurrence_id uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (owner_user_id, source, entity_key, episode_key)
);

CREATE TABLE app.heartbeat_mutes (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('item', 'topic')),
  source text CHECK (source IN ('calendar', 'tasks', 'memory', 'sports', 'news')),
  entity_key text,
  topic text,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX heartbeat_mutes_owner_created
  ON app.heartbeat_mutes (owner_user_id, created_at DESC);

CREATE TABLE app.heartbeat_allowance_charges (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  local_date date NOT NULL,
  occurrence_id uuid NOT NULL,
  attempt smallint NOT NULL,
  PRIMARY KEY (owner_user_id, local_date, occurrence_id, attempt)
);

ALTER TABLE app.heartbeat_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_settings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_source_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_source_checkpoints FORCE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_occurrences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_occurrences FORCE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_findings FORCE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_mutes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_mutes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_allowance_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.heartbeat_allowance_charges FORCE ROW LEVEL SECURITY;

-- Settings: the signed-in owner saves them, the worker creates and advances them.
CREATE POLICY heartbeat_settings_select ON app.heartbeat_settings FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_settings_insert ON app.heartbeat_settings FOR INSERT
  TO jarvis_app_runtime, jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_settings_update ON app.heartbeat_settings FOR UPDATE
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
-- Only the owner-ID listing function below reads across owners, and only as the migration owner.
CREATE POLICY heartbeat_settings_due_listing ON app.heartbeat_settings FOR SELECT
  TO jarvis_migration_owner
  USING (true);
GRANT SELECT, INSERT, UPDATE ON app.heartbeat_settings
  TO jarvis_app_runtime, jarvis_worker_runtime;

CREATE POLICY heartbeat_checkpoints_select ON app.heartbeat_source_checkpoints FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_checkpoints_write ON app.heartbeat_source_checkpoints FOR ALL
  TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.heartbeat_source_checkpoints TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.heartbeat_source_checkpoints TO jarvis_worker_runtime;

CREATE POLICY heartbeat_occurrences_select ON app.heartbeat_occurrences FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_occurrences_insert ON app.heartbeat_occurrences FOR INSERT
  TO jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_occurrences_update ON app.heartbeat_occurrences FOR UPDATE
  TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.heartbeat_occurrences TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.heartbeat_occurrences TO jarvis_worker_runtime;

CREATE POLICY heartbeat_findings_select ON app.heartbeat_findings FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_findings_write ON app.heartbeat_findings FOR ALL
  TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.heartbeat_findings TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.heartbeat_findings TO jarvis_worker_runtime;

-- Mutes: the owner lists and removes them; the worker and chat tools add them.
CREATE POLICY heartbeat_mutes_select ON app.heartbeat_mutes FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_mutes_insert ON app.heartbeat_mutes FOR INSERT
  TO jarvis_app_runtime, jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_mutes_delete ON app.heartbeat_mutes FOR DELETE
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, DELETE ON app.heartbeat_mutes TO jarvis_app_runtime, jarvis_worker_runtime;

CREATE POLICY heartbeat_charges_select ON app.heartbeat_allowance_charges FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY heartbeat_charges_insert ON app.heartbeat_allowance_charges FOR INSERT
  TO jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.heartbeat_allowance_charges TO jarvis_app_runtime;
GRANT SELECT, INSERT ON app.heartbeat_allowance_charges TO jarvis_worker_runtime;

-- Owner IDs and the saved revision only. Owners with no settings row are due (default on);
-- disabled owners never are.
CREATE FUNCTION app.list_heartbeat_due_owners(p_limit integer)
RETURNS TABLE("ownerUserId" uuid, "settingsRevision" integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT u.id AS "ownerUserId", COALESCE(s.revision, 0) AS "settingsRevision"
  FROM app.users u
  LEFT JOIN app.heartbeat_settings s ON s.owner_user_id = u.id
  WHERE u.status = 'active'
    AND (s.owner_user_id IS NULL
      OR (s.enabled AND (s.next_due_at IS NULL OR s.next_due_at <= now())))
  ORDER BY COALESCE(s.next_due_at, '-infinity'::timestamptz), u.id
  LIMIT LEAST(GREATEST(p_limit, 1), 500);
$$;

REVOKE ALL ON FUNCTION app.list_heartbeat_due_owners(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_heartbeat_due_owners(integer) TO jarvis_worker_runtime;
