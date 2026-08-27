-- #1909 Declarative public-source recipes, assignment targets, and truthful health.
-- Owner-only FORCE RLS remains authoritative. The worker receives column-scoped SELECT only for
-- account-export-safe public metadata; recipes, confirmed hosts, opaque parameters, and preview
-- state stay app-runtime-only.

ALTER TABLE app.sports_custom_sources
  ADD COLUMN recipe_json jsonb,
  ADD COLUMN recipe_schema_version smallint,
  ADD COLUMN recipe_fingerprint text,
  ADD COLUMN recipe_status text NOT NULL DEFAULT 'missing',
  ADD COLUMN confirmed_fetch_hosts text[],
  ADD COLUMN authorization_confirmed_at timestamptz;

UPDATE app.sports_custom_sources AS source
SET authorization_confirmed_at = source.validated_at,
    confirmed_fetch_hosts = ARRAY(
      SELECT DISTINCT lower(host)
      FROM unnest(ARRAY[
        substring(source.homepage_url FROM '^https://([^/:?#]+)'),
        substring(source.feed_url FROM '^https://([^/:?#]+)')
      ]) AS host
      WHERE host IS NOT NULL
      ORDER BY lower(host)
    ),
    recipe_status = CASE WHEN source.retrieval_method = 'feed' THEN 'feed' ELSE 'missing' END,
    health_state = CASE WHEN source.retrieval_method = 'scrape' THEN 'failing' ELSE source.health_state END,
    health_reason_code = CASE WHEN source.retrieval_method = 'scrape' THEN 'recipe_missing' ELSE source.health_reason_code END,
    health_message = CASE WHEN source.retrieval_method = 'scrape' THEN 'Rebuild this source recipe before refreshing.' ELSE source.health_message END;

ALTER TABLE app.sports_custom_sources
  ALTER COLUMN confirmed_fetch_hosts SET NOT NULL,
  ALTER COLUMN authorization_confirmed_at SET NOT NULL,
  ADD CONSTRAINT sports_custom_sources_recipe_json_check
    CHECK (recipe_json IS NULL
           OR (jsonb_typeof(recipe_json) = 'object' AND pg_column_size(recipe_json) <= 32768)),
  ADD CONSTRAINT sports_custom_sources_recipe_version_check
    CHECK ((recipe_json IS NULL AND recipe_schema_version IS NULL)
           OR (recipe_json IS NOT NULL AND recipe_schema_version = 1)),
  ADD CONSTRAINT sports_custom_sources_recipe_fingerprint_check
    CHECK ((recipe_json IS NULL AND recipe_fingerprint IS NULL)
           OR (recipe_json IS NOT NULL
               AND char_length(recipe_fingerprint) BETWEEN 1 AND 64)),
  ADD CONSTRAINT sports_custom_sources_recipe_status_check
    CHECK (recipe_status IN ('feed', 'ready', 'missing', 'drift')),
  ADD CONSTRAINT sports_custom_sources_recipe_shape_check
    CHECK ((retrieval_method = 'feed'
              AND recipe_status = 'feed'
              AND recipe_json IS NULL
              AND recipe_schema_version IS NULL
              AND recipe_fingerprint IS NULL)
           OR (retrieval_method = 'scrape'
              AND ((recipe_status = 'missing'
                    AND recipe_json IS NULL
                    AND recipe_schema_version IS NULL
                    AND recipe_fingerprint IS NULL)
                   OR (recipe_status IN ('ready', 'drift')
                       AND recipe_json IS NOT NULL
                       AND recipe_schema_version = 1
                       AND recipe_fingerprint IS NOT NULL)))),
  ADD CONSTRAINT sports_custom_sources_confirmed_hosts_check
    CHECK (cardinality(confirmed_fetch_hosts) BETWEEN 1 AND 6
           AND array_position(confirmed_fetch_hosts, NULL) IS NULL
           AND array_to_string(confirmed_fetch_hosts, ',') = lower(array_to_string(confirmed_fetch_hosts, ','))
           AND array_to_string(confirmed_fetch_hosts, ',') ~ '^[a-z0-9.-]+(,[a-z0-9.-]+)*$'
           AND octet_length(array_to_string(confirmed_fetch_hosts, ',')) <= 1518),
  ADD CONSTRAINT sports_custom_sources_reason_check
    CHECK (health_reason_code IS NULL OR char_length(health_reason_code) <= 64);

ALTER TABLE app.sports_source_assignments
  ADD COLUMN target_url text,
  ADD COLUMN target_parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN preview_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN health_state text NOT NULL DEFAULT 'pending',
  ADD COLUMN health_reason_code text,
  ADD COLUMN health_message text,
  ADD COLUMN last_checked_at timestamptz,
  ADD COLUMN last_success_at timestamptz;

UPDATE app.sports_source_assignments AS assignment
SET target_url = CASE WHEN source.retrieval_method = 'feed' THEN source.feed_url ELSE NULL END,
    preview_status = CASE WHEN source.retrieval_method = 'feed' THEN 'pending' ELSE 'recipe_missing' END,
    health_state = CASE WHEN source.retrieval_method = 'feed' THEN 'pending' ELSE 'failing' END,
    health_reason_code = CASE WHEN source.retrieval_method = 'scrape' THEN 'recipe_missing' ELSE NULL END,
    health_message = CASE WHEN source.retrieval_method = 'scrape' THEN 'Rebuild this source recipe before refreshing.' ELSE NULL END
FROM app.sports_custom_sources AS source
WHERE source.id = assignment.source_id;

ALTER TABLE app.sports_source_assignments
  ADD CONSTRAINT sports_source_assignments_target_url_check
    CHECK (target_url IS NULL
           OR (char_length(target_url) <= 2048 AND target_url LIKE 'https://%')),
  ADD CONSTRAINT sports_source_assignments_parameters_check
    CHECK (jsonb_typeof(target_parameters) = 'object'
           AND pg_column_size(target_parameters) <= 4096),
  ADD CONSTRAINT sports_source_assignments_preview_status_check
    CHECK (preview_status IN ('pending', 'verified', 'recipe_missing')),
  ADD CONSTRAINT sports_source_assignments_preview_target_check
    CHECK (preview_status <> 'verified' OR target_url IS NOT NULL),
  ADD CONSTRAINT sports_source_assignments_health_state_check
    CHECK (health_state IN ('pending', 'healthy', 'failing', 'unsupported', 'auth_required', 'disabled')),
  ADD CONSTRAINT sports_source_assignments_reason_check
    CHECK (health_reason_code IS NULL OR char_length(health_reason_code) <= 64),
  ADD CONSTRAINT sports_source_assignments_message_check
    CHECK (health_message IS NULL OR char_length(health_message) <= 500);

CREATE OR REPLACE FUNCTION app.enforce_sports_source_assignment_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, app
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sports:source-assignments:' || NEW.owner_user_id::text));
  IF (
    SELECT count(*)
    FROM app.sports_source_assignments
    WHERE owner_user_id = NEW.owner_user_id AND id <> NEW.id
  ) >= 20 THEN
    RAISE EXCEPTION 'sports custom source assignment limit exceeded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER sports_source_assignments_limit
BEFORE INSERT OR UPDATE OF owner_user_id ON app.sports_source_assignments
FOR EACH ROW EXECUTE FUNCTION app.enforce_sports_source_assignment_limit();

DROP POLICY IF EXISTS sports_custom_sources_worker_select ON app.sports_custom_sources;
CREATE POLICY sports_custom_sources_worker_select
  ON app.sports_custom_sources FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS sports_source_assignments_worker_select ON app.sports_source_assignments;
CREATE POLICY sports_source_assignments_worker_select
  ON app.sports_source_assignments FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

REVOKE ALL ON app.sports_custom_sources FROM jarvis_worker_runtime;
REVOKE ALL ON app.sports_source_assignments FROM jarvis_worker_runtime;

GRANT SELECT (
  id, owner_user_id, label, canonical_domain, homepage_url, feed_url, retrieval_method, enabled,
  health_state, health_reason_code, health_message, last_checked_at, last_success_at, recipe_status,
  recipe_schema_version, authorization_confirmed_at, validated_at, created_at, updated_at
) ON app.sports_custom_sources TO jarvis_worker_runtime;

GRANT SELECT (
  id, owner_user_id, source_id, follow_id, target_url, health_state, health_reason_code,
  health_message, last_checked_at, last_success_at, created_at
) ON app.sports_source_assignments TO jarvis_worker_runtime;
