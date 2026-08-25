-- #1909 Repair legacy feed assignments skipped while both owner-only tables were FORCE RLS.
-- The migration role is NOBYPASSRLS, so temporarily disable RLS for the bounded backfill and
-- restore both protections before commit.
ALTER TABLE app.sports_custom_sources DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments DISABLE ROW LEVEL SECURITY;

UPDATE app.sports_source_assignments AS assignment
SET target_url = source.feed_url,
    preview_status = 'verified'
FROM app.sports_custom_sources AS source
WHERE source.id = assignment.source_id
  AND source.retrieval_method = 'feed'
  AND source.recipe_status = 'feed'
  AND source.feed_url IS NOT NULL
  AND assignment.preview_status = 'pending'
  AND assignment.target_url IS NULL
  AND assignment.target_parameters = '{}'::jsonb;

ALTER TABLE app.sports_custom_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_custom_sources FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments FORCE ROW LEVEL SECURITY;
