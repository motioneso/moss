-- #2844 — AI providers and models created by an admin stay visible to every admin after the
-- creating admin is demoted.
--
-- 0091 lets any user read a provider or model whose owner is an active admin right now. Once
-- that owner is demoted the predicate fails, so no other admin can see or manage the rows. This
-- migration records "an admin created this row" on the row itself and adds an admin-only read
-- rule keyed on it. Row owners never change (0013's triggers forbid it, and rewriting the owner
-- would make the demoted admin look like the owner of someone else's key).
--
-- The mark is set by a BEFORE INSERT trigger from the inserter's admin status, so a client
-- cannot choose it, and a BEFORE UPDATE trigger refuses any later change. Regular users'
-- personal rows are never marked, so they stay owner-only.

ALTER TABLE app.ai_provider_configs
  ADD COLUMN IF NOT EXISTS created_by_admin boolean NOT NULL DEFAULT false;

ALTER TABLE app.ai_configured_models
  ADD COLUMN IF NOT EXISTS created_by_admin boolean NOT NULL DEFAULT false;

-- One-time backfill, conservative: only rows whose owner is an active admin when this runs.
-- Rows owned by already-demoted admins or by regular users stay unmarked, because the data
-- cannot tell us whether the owner was an admin at creation time. The migration runner is
-- NOBYPASSRLS, so RLS is dropped for the backfill and restored in the same transaction (the
-- 0173 idiom). This runs before the lock trigger exists, so the UPDATE is permitted.
ALTER TABLE app.ai_provider_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models DISABLE ROW LEVEL SECURITY;

UPDATE app.ai_provider_configs c
SET created_by_admin = true
WHERE EXISTS (
  SELECT 1 FROM app.users u
  WHERE u.id = c.owner_user_id AND u.is_instance_admin = true AND u.status = 'active'
);

UPDATE app.ai_configured_models m
SET created_by_admin = true
WHERE EXISTS (
  SELECT 1 FROM app.users u
  WHERE u.id = m.owner_user_id AND u.is_instance_admin = true AND u.status = 'active'
);

ALTER TABLE app.ai_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_provider_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models FORCE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION app.set_ai_created_by_admin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.created_by_admin := COALESCE(app.current_actor_is_admin(), false);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION app.prevent_ai_created_by_admin_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.created_by_admin IS DISTINCT FROM OLD.created_by_admin THEN
    RAISE EXCEPTION 'AI created_by_admin cannot be changed';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_provider_configs_set_created_by_admin ON app.ai_provider_configs;
CREATE TRIGGER ai_provider_configs_set_created_by_admin
BEFORE INSERT ON app.ai_provider_configs
FOR EACH ROW
EXECUTE FUNCTION app.set_ai_created_by_admin();

DROP TRIGGER IF EXISTS ai_configured_models_set_created_by_admin ON app.ai_configured_models;
CREATE TRIGGER ai_configured_models_set_created_by_admin
BEFORE INSERT ON app.ai_configured_models
FOR EACH ROW
EXECUTE FUNCTION app.set_ai_created_by_admin();

DROP TRIGGER IF EXISTS ai_provider_configs_lock_created_by_admin ON app.ai_provider_configs;
CREATE TRIGGER ai_provider_configs_lock_created_by_admin
BEFORE UPDATE OF created_by_admin ON app.ai_provider_configs
FOR EACH ROW
EXECUTE FUNCTION app.prevent_ai_created_by_admin_change();

DROP TRIGGER IF EXISTS ai_configured_models_lock_created_by_admin ON app.ai_configured_models;
CREATE TRIGGER ai_configured_models_lock_created_by_admin
BEFORE UPDATE OF created_by_admin ON app.ai_configured_models
FOR EACH ROW
EXECUTE FUNCTION app.prevent_ai_created_by_admin_change();

-- Additional permissive read rule. It ORs with the 0091 owner / active-admin-owner rule, so
-- nothing that was visible before is hidden, and only an admin actor gains the new rows.
DROP POLICY IF EXISTS ai_provider_configs_select_admin_created ON app.ai_provider_configs;
CREATE POLICY ai_provider_configs_select_admin_created
ON app.ai_provider_configs
FOR SELECT
TO jarvis_app_runtime
USING (
  created_by_admin = true
  AND app.current_actor_is_admin()
);

DROP POLICY IF EXISTS ai_configured_models_select_admin_created ON app.ai_configured_models;
CREATE POLICY ai_configured_models_select_admin_created
ON app.ai_configured_models
FOR SELECT
TO jarvis_app_runtime
USING (
  created_by_admin = true
  AND app.current_actor_is_admin()
);
