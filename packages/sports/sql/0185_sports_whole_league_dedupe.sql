-- packages/sports/sql/0185_sports_whole_league_dedupe.sql
-- Collapses pre-existing whole-league duplicate follows (team_key IS NULL) before 0186 makes them
-- impossible going forward. Plain DELETE with a subquery, no leading WITH -- the wire-contract
-- checker's regexes are anchored to the start of the statement and would not match a CTE opener.
DELETE FROM app.sports_follows
WHERE team_key IS NULL
  AND id IN (
    SELECT id FROM (
      SELECT id,
             row_number() OVER (
               PARTITION BY owner_user_id, competition_key
               ORDER BY created_at ASC, id ASC
             ) AS rn
      FROM app.sports_follows
      WHERE team_key IS NULL
    ) ranked
    WHERE rn > 1
  );
