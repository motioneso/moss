-- packages/sports/sql/0186_sports_whole_league_unique.sql
-- Partial unique index: Postgres treats NULL as distinct in a plain UNIQUE constraint, so
-- 0133's (owner_user_id, competition_key, team_key) UNIQUE never deduped two team_key IS NULL
-- rows. This closes that gap for whole-league follows going forward; 0185 already collapsed
-- pre-existing duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS sports_follows_whole_league_unique_idx
  ON app.sports_follows (owner_user_id, competition_key)
  WHERE team_key IS NULL;
