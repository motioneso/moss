-- #1909 Make the feed assignments backfilled by 0191 eligible for their first runtime refresh.
-- No check timestamp is manufactured; the reader records it only after a real bounded fetch.
-- The migration owner is NOBYPASSRLS, so temporarily disable owner-only FORCE RLS for this
-- transaction-scoped backfill, then restore it before commit.
ALTER TABLE app.sports_custom_sources DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments DISABLE ROW LEVEL SECURITY;

UPDATE app.sports_source_assignments AS assignment
SET preview_status = 'verified'
FROM app.sports_custom_sources AS source
WHERE source.id = assignment.source_id
  AND source.retrieval_method = 'feed'
  AND source.recipe_status = 'feed'
  AND assignment.preview_status = 'pending'
  AND assignment.target_url = source.feed_url
  AND assignment.target_parameters = '{}'::jsonb;

ALTER TABLE app.sports_custom_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_custom_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
