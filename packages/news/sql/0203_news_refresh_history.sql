-- Migration 0203. #2030 (piece 1 of parent #1586) Moss self-diagnostics — refresh
-- attempt/success/failure history for the news module.
--
-- The problem: app.news_refresh_state (created in 0160) is a LIVE status row. failure_kind is
-- cleared at the start of the next run and again on success, and updated_at only records when
-- the row last moved at all. Once the state returns to 'idle', a run that failed an hour ago and
-- a run that succeeded a minute ago are indistinguishable. These columns make the four events
-- separately answerable after the fact.
--
-- The existing state/failure_kind columns keep their meaning: "right now". The new columns mean
-- "the last time this happened, ever", and a later success must not clear them.
--
-- RLS classification: owner-only, including worker access. These columns are added to an existing
-- owner-only FORCE-RLS table. 0160 enables and FORCEs RLS on it, and its SELECT/INSERT/UPDATE/
-- DELETE policies and its GRANT are both table-level for jarvis_app_runtime AND
-- jarvis_worker_runtime (0160 lines 29-60), so the new columns are covered already: this file
-- adds no GRANT and no POLICY. The column-scoped worker UPDATE grants in 0161 target
-- app.news_custom_sources and app.news_custom_topics only, never this table, so they do not
-- narrow what the worker may write here. Worker role remains RLS-bound: no BYPASSRLS, not a
-- superuser, and its writes stay owner-scoped through app.current_actor_user_id().
--
-- Column content is operational metadata only — four timestamps and one of three fixed failure
-- categories, enforced by the CHECK below. No article text, no provider response and no
-- credential ever reaches these columns.
--
-- New file — never edit the applied 0159/0160/0161/0200.

ALTER TABLE app.news_refresh_state
  ADD COLUMN IF NOT EXISTS last_requested_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_attempt_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_success_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_at   timestamptz,
  ADD COLUMN IF NOT EXISTS last_failure_kind text;

-- Drop-then-add is deliberate: a bare ADD CONSTRAINT is not re-runnable, and the migration runner
-- must be able to replay this file on a database where an earlier partial apply already added it.
-- The categories mirror the live failure_kind CHECK in 0160.
ALTER TABLE app.news_refresh_state
  DROP CONSTRAINT IF EXISTS news_refresh_state_last_failure_kind_check;
ALTER TABLE app.news_refresh_state
  ADD CONSTRAINT news_refresh_state_last_failure_kind_check
  CHECK (last_failure_kind IS NULL OR last_failure_kind IN ('fetch', 'ai', 'internal'));
