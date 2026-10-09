-- #3221 The daily upgrade check runs as jarvis_worker_runtime. The worker has no write access to
-- app.instance_settings and cannot see app.users rows without an actor, so the check failed with
-- "permission denied" and no upgrade notice was ever queued.
--
-- The worker may only EXECUTE two narrow SECURITY DEFINER functions owned by
-- jarvis_migration_owner (as 0257). One records the latest_release setting, the other returns up
-- to two bootstrap-owner ids. Both tables force row security and the owner does not bypass it,
-- so the definer gets policies limited to the same rows the functions touch.

CREATE POLICY instance_settings_latest_release_select ON app.instance_settings
  FOR SELECT
  TO jarvis_migration_owner
  USING (key = 'latest_release');

CREATE POLICY instance_settings_latest_release_insert ON app.instance_settings
  FOR INSERT
  TO jarvis_migration_owner
  WITH CHECK (key = 'latest_release');

CREATE POLICY instance_settings_latest_release_update ON app.instance_settings
  FOR UPDATE
  TO jarvis_migration_owner
  USING (key = 'latest_release')
  WITH CHECK (key = 'latest_release');

-- Applies to the whole migration-owner role, so it is deliberately broad: it
-- exposes only the bootstrap owner row to the definer functions in this file.
CREATE POLICY users_bootstrap_owner_select ON app.users
  FOR SELECT
  TO jarvis_migration_owner
  USING (is_bootstrap_owner);

CREATE OR REPLACE FUNCTION app.record_latest_release(p_version text, p_notes text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
BEGIN
  INSERT INTO app.instance_settings (key, value, updated_by_user_id, created_at, updated_at)
  VALUES (
    'latest_release',
    jsonb_build_object('version', p_version, 'notes', coalesce(p_notes, '')),
    NULL,
    now(),
    now()
  )
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION app.upgrade_notify_owner_ids()
RETURNS TABLE (id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'app', 'public'
AS $$
  SELECT u.id
  FROM app.users u
  WHERE u.is_bootstrap_owner
  ORDER BY u.created_at ASC, u.id ASC
  LIMIT 2;
$$;

REVOKE ALL ON FUNCTION app.record_latest_release(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION app.upgrade_notify_owner_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.record_latest_release(text, text) TO jarvis_worker_runtime;
GRANT EXECUTE ON FUNCTION app.upgrade_notify_owner_ids() TO jarvis_worker_runtime;
