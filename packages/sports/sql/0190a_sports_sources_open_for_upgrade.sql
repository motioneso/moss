-- #3201 Lets migration 0191 backfill existing custom sources.
--
-- 0190 put these tables under FORCE ROW LEVEL SECURITY with policies for the runtime roles only.
-- Migrations run as jarvis_migration_owner (the table owner, NOBYPASSRLS), so under FORCE the
-- owner sees no rows: the 0191 backfills update nothing and its SET NOT NULL then fails on any
-- install that already has a source. NO FORCE lets the owner see its own rows for 0191 only;
-- 0191a restores FORCE. Runtime roles are unaffected either way. Idempotent on installs that
-- already applied 0191.
ALTER TABLE app.sports_custom_sources NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.sports_source_assignments NO FORCE ROW LEVEL SECURITY;
