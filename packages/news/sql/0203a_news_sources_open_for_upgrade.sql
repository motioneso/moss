-- #3201 Lets migrations 0204 and 0218 rewrite existing custom sources.
--
-- 0159 put app.news_custom_sources under FORCE ROW LEVEL SECURITY with policies for the runtime
-- roles only. Migrations run as jarvis_migration_owner (the table owner, NOBYPASSRLS), so under
-- FORCE the owner sees no rows: the 0204 and 0218 backfills update nothing and the new CHECK
-- constraints then reject the untouched rows. NO FORCE lets the owner see its own rows until
-- 0218a restores FORCE.
--
-- Once the rows are visible, the 0204 rewrite to the new health values would trip the old CHECK
-- that 0204 only drops afterwards, so the old CHECK is dropped here. The drop applies only to the
-- old definition; an install that already applied 0204 keeps its new CHECK. 0204 adds the new one.
--
-- Runtime roles are unaffected either way. Idempotent on installs that already applied 0204/0218.
ALTER TABLE app.news_custom_sources NO FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'app.news_custom_sources'::regclass
       AND conname = 'news_custom_sources_health_status_check'
       AND pg_get_constraintdef(oid) LIKE '%''available''%'
  ) THEN
    ALTER TABLE app.news_custom_sources DROP CONSTRAINT news_custom_sources_health_status_check;
  END IF;
END
$$;
