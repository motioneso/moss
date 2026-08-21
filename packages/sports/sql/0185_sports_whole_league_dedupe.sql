-- packages/sports/sql/0185_sports_whole_league_dedupe.sql
-- Collapses pre-existing whole-league duplicate follows (team_key IS NULL) before 0186 makes them
-- impossible going forward. Plain DELETE with a subquery, no leading WITH -- the wire-contract
-- checker's regexes are anchored to the start of the statement and would not match a CTE opener.
--
-- Three statements, not one: 0133 put app.sports_follows under FORCE ROW LEVEL SECURITY with
-- policies granted only to jarvis_app_runtime. Migrations run as jarvis_migration_owner (the
-- table's owner, but NOBYPASSRLS and not a member of jarvis_app_runtime), so under FORCE that role
-- has no applicable policy and a plain DELETE here would silently match zero rows -- discovered by
-- the upgrade-path harness test seeding real duplicate rows and watching this file fail to remove
-- them. NO FORCE lets the owner role see and delete every row for the statements in between; FORCE
-- is restored before the migration transaction commits, unchanged from 0133 in every other respect.
ALTER TABLE app.sports_follows NO FORCE ROW LEVEL SECURITY;

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

ALTER TABLE app.sports_follows FORCE ROW LEVEL SECURITY;
