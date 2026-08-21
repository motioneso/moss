-- Fan a draft module out to its owner alone (#1753, Workshop 2). A draft's own author
-- cannot deny themselves their own draft via app.module_enablement — that deny-list only
-- ever applied to the 'enabled' fan-out case, which is unchanged below.
--
-- jarvis_migration_owner's SELECT policy on app.external_modules (0158) only covered
-- status = 'enabled' rows; widen it to 'draft' too so this function can see them.

DROP POLICY IF EXISTS external_modules_scheduler_owner_select
  ON app.external_modules;
CREATE POLICY external_modules_scheduler_owner_select
ON app.external_modules
FOR SELECT
TO jarvis_migration_owner
USING (status IN ('enabled', 'draft'));

CREATE OR REPLACE FUNCTION app.list_active_external_module_users(target_module_id text)
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT modules.owner_user_id AS user_id
  FROM app.external_modules AS modules
  WHERE modules.id = target_module_id
    AND modules.status = 'draft'
    AND modules.owner_user_id IS NOT NULL

  UNION ALL

  SELECT users.id AS user_id
  FROM app.users AS users
  WHERE users.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM app.external_modules AS modules
      WHERE modules.id = target_module_id
        AND modules.status = 'enabled'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM app.module_enablement AS denied
      WHERE denied.module_id = target_module_id
        AND (
          denied.scope = 'instance'
          OR (denied.scope = 'user' AND denied.user_id = users.id)
        )
    )
  ORDER BY user_id
$$;
