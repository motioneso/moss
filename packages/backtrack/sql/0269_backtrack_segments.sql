-- #2638 Backtrack phase 2a: the day-memory table, the Moss-side pause, and deletion markers
-- (spec 2026-09-23-trail-marker-screen-history.md §6, plan 2026-10-03-backtrack-phase2.md §4.2).
--
-- Decision 2: retention runs per owner inside the owner's own data context, not as one
-- SECURITY DEFINER delete -- the purge must also remove the segment's embeddings, which live in
-- memory's own table, and a backtrack-owned definer touching app.memory_chunks would break
-- module isolation. So app.backtrack_owners_needing_upkeep() below returns only the owner ids
-- with expired rows (metadata, no content); the hourly job then opens each owner's own data
-- context and deletes there, through the ordinary owner-only policies.
--
-- Decision 3: index, purge and user delete each take a per-owner advisory lock
-- (pg_advisory_xact_lock(hashtextextended('backtrack:' || owner, 0)), see BacktrackRepository)
-- before touching a row, so a queued index job can never recreate an embedding a purge or delete
-- just removed.
--
-- Decision 4: device_id has no foreign key, as app.focus_judgments (0240) -- app.companion_devices
-- is readable only by the auth runtime role, and revoking a Mac hard-deletes its device row while
-- the history stays (an ordinary state; Settings always shows delete, with or without a linked
-- Mac).
--
-- Decision 10: deletion markers, checked by the ingest route and by delete under the same owner
-- lock, so a retried or late upload can never undo a delete.

CREATE TABLE app.backtrack_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL, -- no FK: decision 4
  started_at timestamptz NOT NULL, -- server time (decision 10)
  ended_at timestamptz NOT NULL,
  app_name text NOT NULL CHECK (octet_length(app_name) <= 400),
  bundle_id text NOT NULL CHECK (octet_length(bundle_id) <= 255),
  window_title text NOT NULL CHECK (octet_length(window_title) <= 1000),
  address text CHECK (octet_length(address) <= 2048),
  body text NOT NULL CHECK (octet_length(body) <= 8192),
  body_hash bytea NOT NULL CHECK (octet_length(body_hash) = 32), -- SHA-256 of the redacted UTF-8 body, server-side
  search tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', window_title || ' ' || coalesce(address, '') || ' ' || body)
  ) STORED,
  indexed_at timestamptz, -- decision 5: nullable, set by the index job
  created_at timestamptz NOT NULL DEFAULT now(),
  client_started_at timestamptz NOT NULL, -- the Mac's raw start, for idempotency only
  CHECK (ended_at >= started_at),
  UNIQUE (owner_user_id, device_id, body_hash, client_started_at)
);

CREATE INDEX backtrack_segments_owner_time ON app.backtrack_segments (owner_user_id, started_at DESC);
CREATE INDEX backtrack_segments_unindexed ON app.backtrack_segments (created_at) WHERE indexed_at IS NULL;
CREATE INDEX backtrack_segments_search ON app.backtrack_segments USING gin (search);

ALTER TABLE app.backtrack_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_segments FORCE ROW LEVEL SECURITY;

CREATE POLICY backtrack_segments_select ON app.backtrack_segments
  FOR SELECT TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_segments_insert ON app.backtrack_segments
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_segments_delete ON app.backtrack_segments
  FOR DELETE TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_segments_worker_select ON app.backtrack_segments
  FOR SELECT TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_segments_worker_delete ON app.backtrack_segments
  FOR DELETE TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

-- Worker UPDATE is column-restricted below (GRANT UPDATE (indexed_at)); the row policy still
-- needs to exist so FORCE ROW LEVEL SECURITY lets that narrower grant through at all.
CREATE POLICY backtrack_segments_worker_update ON app.backtrack_segments
  FOR UPDATE TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id())
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, DELETE ON app.backtrack_segments TO jarvis_app_runtime;
GRANT SELECT, DELETE ON app.backtrack_segments TO jarvis_worker_runtime;
GRANT UPDATE (indexed_at) ON app.backtrack_segments TO jarvis_worker_runtime;

-- Moss's pause switch (decision 6): one row per owner, one switch across every linked Mac.
CREATE TABLE app.backtrack_preferences (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  paused boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE app.backtrack_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_preferences FORCE ROW LEVEL SECURITY;

CREATE POLICY backtrack_preferences_select ON app.backtrack_preferences
  FOR SELECT TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_preferences_insert ON app.backtrack_preferences
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_preferences_update ON app.backtrack_preferences
  FOR UPDATE TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id())
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

-- The worker reads pause state while ingesting (decision 6); it never writes it.
CREATE POLICY backtrack_preferences_worker_select ON app.backtrack_preferences
  FOR SELECT TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE ON app.backtrack_preferences TO jarvis_app_runtime;
GRANT SELECT ON app.backtrack_preferences TO jarvis_worker_runtime;

-- Deletion markers (decision 10). The app runtime writes one at delete time and reads them back
-- (the ingest overlap check runs in the owner's own request); the worker reads and deletes expired
-- ones in the hourly upkeep job.
CREATE TABLE app.backtrack_deletions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  range tstzrange NOT NULL, -- '[from, least(to, deleted_at))', or '(,deleted_at)' for everything
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX backtrack_deletions_owner ON app.backtrack_deletions (owner_user_id); -- a person has few markers

ALTER TABLE app.backtrack_deletions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.backtrack_deletions FORCE ROW LEVEL SECURITY;

CREATE POLICY backtrack_deletions_select ON app.backtrack_deletions
  FOR SELECT TO jarvis_app_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_deletions_insert ON app.backtrack_deletions
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_deletions_worker_select ON app.backtrack_deletions
  FOR SELECT TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

CREATE POLICY backtrack_deletions_worker_delete ON app.backtrack_deletions
  FOR DELETE TO jarvis_worker_runtime
  USING (app.current_actor_user_id() IS NOT NULL AND owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT ON app.backtrack_deletions TO jarvis_app_runtime;
GRANT SELECT, DELETE ON app.backtrack_deletions TO jarvis_worker_runtime;

-- Maintenance (decision 2 / review round 1 finding S1): jarvis_migration_owner does not bypass
-- forced row security (see infra/postgres/migrations/0257's identical note), so without these two
-- policies the definer below would see zero rows and the hourly job would silently upkeep nobody.
-- Fixed cutoffs, no arguments -- a caller cannot widen what this sees.
CREATE POLICY backtrack_segments_upkeep_select ON app.backtrack_segments
  FOR SELECT TO jarvis_migration_owner
  USING (
    started_at < now() - interval '37 days'
    OR created_at < now() - interval '37 days'
    OR (indexed_at IS NULL AND created_at < now() - interval '10 minutes')
  );

CREATE POLICY backtrack_deletions_upkeep_select ON app.backtrack_deletions
  FOR SELECT TO jarvis_migration_owner
  USING (created_at < now() - interval '38 days');

-- Returns only the owner ids that need upkeep (metadata, no content) -- the hourly job then opens
-- each owner's own data context and deletes there, under the ordinary owner-only policies above.
CREATE FUNCTION app.backtrack_owners_needing_upkeep()
RETURNS TABLE (owner_user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
  SELECT owner_user_id FROM app.backtrack_segments
  WHERE started_at < now() - interval '37 days'
     OR created_at < now() - interval '37 days'
     OR (indexed_at IS NULL AND created_at < now() - interval '10 minutes')
  UNION
  SELECT owner_user_id FROM app.backtrack_deletions WHERE created_at < now() - interval '38 days'
$$;

ALTER FUNCTION app.backtrack_owners_needing_upkeep() OWNER TO jarvis_migration_owner;
REVOKE ALL ON FUNCTION app.backtrack_owners_needing_upkeep() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.backtrack_owners_needing_upkeep() TO jarvis_worker_runtime;
