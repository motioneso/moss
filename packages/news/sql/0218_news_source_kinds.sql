-- #2282 (global migration 0218). Subreddit sources, per-source fetch host allowlist,
-- workaround failure count. Owner-only FORCE RLS from 0159 unchanged.
--
-- retrieval_method gains 'reddit'. A Reddit row is pinned to one shape (canonical_domain
-- 'reddit.com', homepage under https://www.reddit.com/r/, feed_url the subreddit's hot.rss) so
-- the reader never has to guess. Uniqueness splits into two partial indexes: publications stay
-- unique per (owner, canonical_domain); subreddits are unique per (owner, lower(feed_url)) so
-- one owner cannot hold r/nfl and r/NFL while many subreddits share canonical_domain
-- 'reddit.com'.
--
-- confirmed_fetch_hosts is the lowercase list of hosts the source was verified to fetch from
-- (homepage host, feed host, and any redirect target confirmed at add time). The collector
-- honours it when a feed lives on a different host than the publisher. Existing rows are
-- backfilled from their homepage and feed hosts, then the default is dropped so every writer
-- must supply the list.
--
-- consecutive_failures counts back-to-back refresh failures for workaround feeds (a feed on a
-- host the publisher does not own); at 3 the refresh worker marks the source
-- temporarily_unavailable. icon_url is the publisher's https icon, never export data.

ALTER TABLE app.news_custom_sources
  ADD COLUMN IF NOT EXISTS icon_url text
    CHECK (icon_url IS NULL OR (char_length(icon_url) <= 2048 AND icon_url LIKE 'https://%'));

ALTER TABLE app.news_custom_sources
  ADD COLUMN IF NOT EXISTS confirmed_fetch_hosts text[] NOT NULL DEFAULT '{}';

UPDATE app.news_custom_sources
   SET confirmed_fetch_hosts = ARRAY(SELECT DISTINCT h FROM unnest(ARRAY[
         lower(split_part(split_part(homepage_url, '://', 2), '/', 1)),
         lower(split_part(split_part(coalesce(feed_url, homepage_url), '://', 2), '/', 1))]) AS h
       WHERE h <> '')
 WHERE cardinality(confirmed_fetch_hosts) = 0;

ALTER TABLE app.news_custom_sources ALTER COLUMN confirmed_fetch_hosts DROP DEFAULT;

ALTER TABLE app.news_custom_sources
  DROP CONSTRAINT IF EXISTS news_custom_sources_confirmed_fetch_hosts_check,
  ADD CONSTRAINT news_custom_sources_confirmed_fetch_hosts_check
    CHECK (cardinality(confirmed_fetch_hosts) BETWEEN 1 AND 8
           AND array_position(confirmed_fetch_hosts, NULL) IS NULL
           AND array_position(confirmed_fetch_hosts, '') IS NULL
           AND confirmed_fetch_hosts::text = lower(confirmed_fetch_hosts::text));

ALTER TABLE app.news_custom_sources
  ADD COLUMN IF NOT EXISTS consecutive_failures smallint NOT NULL DEFAULT 0
    CHECK (consecutive_failures BETWEEN 0 AND 3);

ALTER TABLE app.news_custom_sources
  DROP CONSTRAINT IF EXISTS news_custom_sources_retrieval_method_check,
  ADD CONSTRAINT news_custom_sources_retrieval_method_check
    CHECK (retrieval_method IN ('feed', 'scrape', 'reddit'));

ALTER TABLE app.news_custom_sources
  DROP CONSTRAINT IF EXISTS news_custom_sources_reddit_shape_check,
  ADD CONSTRAINT news_custom_sources_reddit_shape_check
    CHECK (retrieval_method <> 'reddit'
           OR (canonical_domain = 'reddit.com'
               AND homepage_url LIKE 'https://www.reddit.com/r/%'
               AND feed_url IS NOT NULL
               AND feed_url LIKE 'https://www.reddit.com/r/%/hot.rss'));

ALTER TABLE app.news_custom_sources
  DROP CONSTRAINT IF EXISTS news_custom_sources_owner_user_id_canonical_domain_key;

CREATE UNIQUE INDEX IF NOT EXISTS news_custom_sources_owner_domain_unique
  ON app.news_custom_sources (owner_user_id, canonical_domain)
  WHERE retrieval_method <> 'reddit';

CREATE UNIQUE INDEX IF NOT EXISTS news_custom_sources_owner_subreddit_unique
  ON app.news_custom_sources (owner_user_id, lower(feed_url))
  WHERE retrieval_method = 'reddit';

-- The refresh worker updates the failure count with the health transition (0160/0204 grant
-- health_status only). Owner-scoped worker policies from 0160 apply unchanged.
GRANT UPDATE (health_status, consecutive_failures) ON app.news_custom_sources
  TO jarvis_worker_runtime;
