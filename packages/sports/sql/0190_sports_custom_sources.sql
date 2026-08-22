-- packages/sports/sql/0190_sports_custom_sources.sql
-- #1572 Custom public news sources by team and league.
-- RLS classification: owner-only (FORCE — applies to every actor including admins) for all
-- four tables. No jarvis_worker_runtime grants: this feature has no background worker path,
-- headlines are fetched synchronously through the existing dataset-connector TTL cache
-- (spec docs/superpowers/specs/2026-08-17-1572-custom-sports-news-sources.md).
--
--   app.sports_custom_sources      user-added publisher, one row per owner+domain
--   app.sports_source_assignments  which followed team/league (app.sports_follows row) a
--                                   source's headlines are attached to
--   app.sports_policy_verdicts     cached allow/reject verdict for a domain, reused across
--                                   preview attempts (mirrors app.news_policy_verdicts' role)
--   app.sports_headline_prefs      per-owner toggle to disable built-in ESPN headlines
--
-- canonical_domain columns store a lowercase ASCII hostname (punycode for IDN), already
-- normalized by the reused News normalizePublisherDomain — the CHECKs here are defense-in-depth
-- bounds, not the parser.

CREATE TABLE IF NOT EXISTS app.sports_custom_sources (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  label                  text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  canonical_domain       text NOT NULL
    CHECK (char_length(canonical_domain) BETWEEN 1 AND 253
           AND canonical_domain = lower(canonical_domain)),
  homepage_url           text NOT NULL
    CHECK (char_length(homepage_url) <= 2048 AND homepage_url LIKE 'https://%'),
  feed_url               text
    CHECK (feed_url IS NULL
           OR (char_length(feed_url) <= 2048 AND feed_url LIKE 'https://%')),
  retrieval_method       text NOT NULL CHECK (retrieval_method IN ('feed', 'scrape')),
  enabled                boolean NOT NULL DEFAULT true,
  health_state           text NOT NULL DEFAULT 'pending'
    CHECK (health_state IN ('pending', 'healthy', 'failing', 'unsupported', 'auth_required', 'disabled')),
  health_reason_code     text,
  health_message         text CHECK (health_message IS NULL OR char_length(health_message) <= 500),
  last_checked_at        timestamptz,
  last_success_at        timestamptz,
  validation_fingerprint text NOT NULL CHECK (char_length(validation_fingerprint) <= 255),
  validated_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, canonical_domain)
);

CREATE INDEX IF NOT EXISTS sports_custom_sources_owner_idx
  ON app.sports_custom_sources (owner_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app.sports_source_assignments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id  uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_id      uuid NOT NULL REFERENCES app.sports_custom_sources(id) ON DELETE CASCADE,
  follow_id      uuid NOT NULL REFERENCES app.sports_follows(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, follow_id)
);

CREATE INDEX IF NOT EXISTS sports_source_assignments_owner_idx
  ON app.sports_source_assignments (owner_user_id, source_id);

CREATE INDEX IF NOT EXISTS sports_source_assignments_follow_idx
  ON app.sports_source_assignments (follow_id);

CREATE TABLE IF NOT EXISTS app.sports_policy_verdicts (
  owner_user_id     uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  canonical_domain  text NOT NULL
    CHECK (canonical_domain = lower(canonical_domain) AND char_length(canonical_domain) <= 253),
  fingerprint       text NOT NULL CHECK (char_length(fingerprint) <= 255),
  verdict           text NOT NULL CHECK (verdict IN ('approved', 'rejected')),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, canonical_domain)
);

CREATE TABLE IF NOT EXISTS app.sports_headline_prefs (
  owner_user_id          uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  espn_headlines_enabled boolean NOT NULL DEFAULT true,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Owner-only FORCE RLS + app-runtime-only grants, identical posture for all four tables.
-- (Plain DO block instead of a helper function to keep the migration self-contained, mirroring
-- packages/news/sql/0159_news_personalization.sql.)
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'sports_custom_sources',
    'sports_source_assignments',
    'sports_policy_verdicts',
    'sports_headline_prefs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE app.%I FORCE ROW LEVEL SECURITY', tbl);

    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', tbl || '_select', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR SELECT TO jarvis_app_runtime
         USING (owner_user_id = app.current_actor_user_id())',
      tbl || '_select', tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', tbl || '_insert', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR INSERT TO jarvis_app_runtime
         WITH CHECK (owner_user_id = app.current_actor_user_id())',
      tbl || '_insert', tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', tbl || '_update', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR UPDATE TO jarvis_app_runtime
         USING (owner_user_id = app.current_actor_user_id())
         WITH CHECK (owner_user_id = app.current_actor_user_id())',
      tbl || '_update', tbl
    );

    EXECUTE format('DROP POLICY IF EXISTS %I ON app.%I', tbl || '_delete', tbl);
    EXECUTE format(
      'CREATE POLICY %I ON app.%I FOR DELETE TO jarvis_app_runtime
         USING (owner_user_id = app.current_actor_user_id())',
      tbl || '_delete', tbl
    );

    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON app.%I TO jarvis_app_runtime', tbl
    );
    -- No jarvis_worker_runtime grants: no background worker touches this data.
  END LOOP;
END
$$;
