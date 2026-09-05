-- #2211 Subreddit sources (global migration 0213).
-- A subreddit is a third retrieval method for app.sports_custom_sources: recipe-less like a feed,
-- with the public new-posts listing URL in feed_url, canonical_domain 'reddit.com', and the
-- community icon URL in the new icon_url column for the source-icon route.
--
-- Every subreddit shares canonical_domain 'reddit.com', so the per-owner domain uniqueness from
-- 0190 becomes two partial unique indexes: publications still collide on domain; subreddits
-- collide on their lower-cased listing URL (r/nfl and r/NFL are one source).
-- Owner-only FORCE RLS from 0190 is unchanged; the worker's column-scoped SELECT from 0191 does
-- not gain icon_url (it is not export data).

ALTER TABLE app.sports_custom_sources
  ADD COLUMN icon_url text
    CHECK (icon_url IS NULL
           OR (char_length(icon_url) <= 2048 AND icon_url LIKE 'https://%'));

ALTER TABLE app.sports_custom_sources
  DROP CONSTRAINT IF EXISTS sports_custom_sources_retrieval_method_check,
  ADD CONSTRAINT sports_custom_sources_retrieval_method_check
    CHECK (retrieval_method IN ('feed', 'scrape', 'reddit'));

ALTER TABLE app.sports_custom_sources
  DROP CONSTRAINT IF EXISTS sports_custom_sources_recipe_shape_check,
  ADD CONSTRAINT sports_custom_sources_recipe_shape_check
    CHECK ((retrieval_method IN ('feed', 'reddit')
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
                       AND recipe_fingerprint IS NOT NULL))));

ALTER TABLE app.sports_custom_sources
  ADD CONSTRAINT sports_custom_sources_reddit_shape_check
    CHECK (retrieval_method <> 'reddit'
           OR (canonical_domain = 'reddit.com'
               AND feed_url IS NOT NULL
               AND feed_url LIKE 'https://www.reddit.com/r/%'));

ALTER TABLE app.sports_custom_sources
  DROP CONSTRAINT IF EXISTS sports_custom_sources_owner_user_id_canonical_domain_key;

CREATE UNIQUE INDEX IF NOT EXISTS sports_custom_sources_owner_domain_unique
  ON app.sports_custom_sources (owner_user_id, canonical_domain)
  WHERE retrieval_method <> 'reddit';

CREATE UNIQUE INDEX IF NOT EXISTS sports_custom_sources_owner_subreddit_unique
  ON app.sports_custom_sources (owner_user_id, lower(feed_url))
  WHERE retrieval_method = 'reddit';
