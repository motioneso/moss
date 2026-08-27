-- #1961 Sport-wide custom and ESPN headline coverage (global migration 0196).
-- Both assignment tables are owner-only under ENABLE + FORCE RLS. ESPN scope rows control
-- headlines only; the provider remains available for every non-headline Sports dataset.

ALTER TABLE app.sports_source_assignments
  ADD COLUMN sport_key text,
  ALTER COLUMN follow_id DROP NOT NULL,
  DROP CONSTRAINT IF EXISTS sports_source_assignments_source_id_follow_id_key,
  ADD CONSTRAINT sports_source_assignments_target_check
    CHECK (num_nonnulls(sport_key, follow_id) = 1),
  ADD CONSTRAINT sports_source_assignments_sport_key_check
    CHECK (sport_key IS NULL
           OR (char_length(sport_key) BETWEEN 1 AND 32
               AND sport_key = lower(sport_key)
               AND sport_key ~ '^[a-z][a-z0-9_-]*$'));

CREATE UNIQUE INDEX sports_source_assignments_source_follow_unique
  ON app.sports_source_assignments (source_id, follow_id)
  WHERE follow_id IS NOT NULL;

CREATE UNIQUE INDEX sports_source_assignments_source_sport_unique
  ON app.sports_source_assignments (source_id, sport_key)
  WHERE sport_key IS NOT NULL;

CREATE TABLE app.sports_espn_source_assignments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  sport_key     text,
  follow_id     uuid REFERENCES app.sports_follows(id) ON DELETE CASCADE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sports_espn_source_assignments_target_check
    CHECK (num_nonnulls(sport_key, follow_id) = 1),
  CONSTRAINT sports_espn_source_assignments_sport_key_check
    CHECK (sport_key IS NULL
           OR (char_length(sport_key) BETWEEN 1 AND 32
               AND sport_key = lower(sport_key)
               AND sport_key ~ '^[a-z][a-z0-9_-]*$'))
);

CREATE UNIQUE INDEX sports_espn_source_assignments_owner_follow_unique
  ON app.sports_espn_source_assignments (owner_user_id, follow_id)
  WHERE follow_id IS NOT NULL;

CREATE UNIQUE INDEX sports_espn_source_assignments_owner_sport_unique
  ON app.sports_espn_source_assignments (owner_user_id, sport_key)
  WHERE sport_key IS NOT NULL;

CREATE INDEX sports_espn_source_assignments_follow_idx
  ON app.sports_espn_source_assignments (follow_id)
  WHERE follow_id IS NOT NULL;

CREATE OR REPLACE FUNCTION app.enforce_sports_espn_source_assignment_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sports:source-assignments:' || NEW.owner_user_id::text));
  IF (
    SELECT count(*)
    FROM app.sports_espn_source_assignments
    WHERE owner_user_id = NEW.owner_user_id AND id <> NEW.id
  ) >= 20 THEN
    RAISE EXCEPTION 'sports ESPN source assignment limit exceeded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sports_espn_source_assignments_limit
BEFORE INSERT OR UPDATE OF owner_user_id ON app.sports_espn_source_assignments
FOR EACH ROW EXECUTE FUNCTION app.enforce_sports_espn_source_assignment_limit();

ALTER TABLE app.sports_source_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sports_espn_source_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_espn_source_assignments FORCE ROW LEVEL SECURITY;

CREATE POLICY sports_espn_source_assignments_select
  ON app.sports_espn_source_assignments FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY sports_espn_source_assignments_insert
  ON app.sports_espn_source_assignments FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY sports_espn_source_assignments_update
  ON app.sports_espn_source_assignments FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY sports_espn_source_assignments_delete
  ON app.sports_espn_source_assignments FOR DELETE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

CREATE POLICY sports_espn_source_assignments_worker_select
  ON app.sports_espn_source_assignments FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY sports_headline_prefs_worker_select
  ON app.sports_headline_prefs FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE
  ON app.sports_espn_source_assignments TO jarvis_app_runtime;
REVOKE ALL ON app.sports_espn_source_assignments FROM jarvis_worker_runtime;
REVOKE ALL ON app.sports_headline_prefs FROM jarvis_worker_runtime;

GRANT SELECT (sport_key) ON app.sports_source_assignments TO jarvis_worker_runtime;
GRANT SELECT (id, owner_user_id, follow_id, sport_key, created_at)
  ON app.sports_espn_source_assignments TO jarvis_worker_runtime;
GRANT SELECT (owner_user_id, espn_headlines_enabled, updated_at)
  ON app.sports_headline_prefs TO jarvis_worker_runtime;
