-- #1383: narrow audit-insert grant for the new sanctioned admin-reset-password CLI
-- (scripts/admin-reset-password.ts). The CLI connects as jarvis_migration_owner (never the
-- bootstrap superuser) and writes app.auth_accounts under `SET LOCAL ROLE jarvis_auth_runtime`
-- for that one statement only (0045_auth_secret_rls.sql scopes that table to jarvis_auth_runtime);
-- the audit row is written back on jarvis_migration_owner afterward via RESET ROLE, so no new
-- grant is needed there — jarvis_migration_owner is the table owner (created it via the migration
-- runner) and app.admin_audit_events has FORCE ROW LEVEL SECURITY, so only a scoped policy is
-- required, mirroring 0095_bootstrap_audit_security_definer.sql's precedent for the same table.
--
-- Scoped to exactly one action so a compromised or buggy caller can't use this policy to write
-- arbitrary audit rows under the migration-owner role.
DROP POLICY IF EXISTS admin_audit_events_password_reset_insert ON app.admin_audit_events;
CREATE POLICY admin_audit_events_password_reset_insert ON app.admin_audit_events
  FOR INSERT TO jarvis_migration_owner
  WITH CHECK (
    action = 'admin_password_reset'
    AND target_type = 'user'
  );
