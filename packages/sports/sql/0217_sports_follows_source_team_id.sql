-- packages/sports/sql/0217_sports_follows_source_team_id.sql
-- Round 5 of review finding S1: a saved follow now stores the provider's permanent team id in its
-- own column, and that column is the ONLY identity used to match games, standings, briefing facts
-- and news. team_key keeps exactly two jobs: NULL still means "follow the whole competition"
-- (0133/0186), and a non-NULL value is the team's short name, used for display and for suggesting
-- candidates in the one-time "which team did you mean?" prompt. It is never matched on again.
--
-- Rounds 1-4 each shipped a different rule for reading team_key (bare short name, short-name-and-id
-- key, bare id) and each rule was found attaching a follow to the wrong team. There is no reading
-- left: a row with source_team_id IS NULL matches nothing anywhere until the person picks a team.
ALTER TABLE app.sports_follows ADD COLUMN IF NOT EXISTS source_team_id text;

-- 0133's UNIQUE (owner_user_id, competition_key, team_key) has to go: team_key is now a display
-- short name, and the whole point of this change is that two different teams in one competition
-- can legitimately share one short name (two schools both answering "PAC"). Keeping the old
-- constraint would make following the second of them fail outright. Identity uniqueness moves to
-- the permanent id below; whole-competition uniqueness stays on 0186's partial index.
--
-- 0133 declared the constraint inline, so Postgres named it; the literal below is that generated
-- name. The DO block behind it drops the constraint whatever it is called, by matching its exact
-- column set, so an install whose name differs is still corrected.
ALTER TABLE app.sports_follows
  DROP CONSTRAINT IF EXISTS sports_follows_owner_user_id_competition_key_team_key_key;

DO $$
DECLARE
  doomed text;
BEGIN
  SELECT con.conname INTO doomed
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
  WHERE nsp.nspname = 'app'
    AND rel.relname = 'sports_follows'
    AND con.contype = 'u'
    AND (
      SELECT array_agg(att.attname::text ORDER BY att.attname::text)
      FROM pg_attribute att
      WHERE att.attrelid = rel.oid AND att.attnum = ANY (con.conkey)
    ) = ARRAY['competition_key', 'owner_user_id', 'team_key']
  LIMIT 1;
  IF doomed IS NOT NULL THEN
    EXECUTE format('ALTER TABLE app.sports_follows DROP CONSTRAINT %I', doomed);
  END IF;
END
$$;

-- One follow per person, per competition, per real team. Partial so the older rows that have no
-- permanent id yet, and every whole-competition row, stay outside it.
CREATE UNIQUE INDEX IF NOT EXISTS sports_follows_source_team_unique_idx
  ON app.sports_follows (owner_user_id, competition_key, source_team_id)
  WHERE source_team_id IS NOT NULL;
