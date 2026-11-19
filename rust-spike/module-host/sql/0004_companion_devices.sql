-- Companion device lookup for the sign-in gate and the Meetings stores.
-- The four tables come from the core ledger and are readable only by jarvis_auth_runtime.
-- Everything here is owned by that role, so FORCE RLS admits it, and the app role reaches
-- devices only through the owner-only view and the narrow functions below.
-- No object here returns credential_hash, pair_attempt_id or any proof hash.

-- Resolves a presented credential hash to its device before any actor is known. Refreshes
-- last_contact_at and slides the inactivity expiry (90 days, never past the absolute cap).
-- A revoked device has no row, and an expired row is refused. A pending or deactivated
-- account's device still resolves, so the caller can name the state, but its expiry and last
-- contact time are never extended.
CREATE OR REPLACE FUNCTION app.resolve_companion_device(p_hash text)
  RETURNS TABLE(user_id uuid, device_id uuid, platform text, capability_revision integer, expires_at timestamptz)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = app, pg_temp
AS $$
  WITH hit AS (
    UPDATE companion_devices d
       SET last_contact_at = CASE WHEN COALESCE((SELECT u.status FROM users u WHERE u.id = d.user_id), '') NOT IN ('pending', 'deactivated') THEN now() ELSE d.last_contact_at END,
           expires_at = CASE WHEN COALESCE((SELECT u.status FROM users u WHERE u.id = d.user_id), '') NOT IN ('pending', 'deactivated')
                             THEN LEAST(now() + interval '90 days', d.absolute_expires_at)
                             ELSE d.expires_at END
     WHERE d.credential_hash = p_hash
       AND d.expires_at > now()
       AND d.absolute_expires_at > now()
    RETURNING d.user_id, d.id, d.platform, d.expires_at
  )
  SELECT h.user_id, h.id, h.platform,
         (SELECT c.revision FROM companion_recording_capabilities c
           WHERE c.device_id = h.id AND c.revoked_at IS NULL),
         h.expires_at
    FROM hit h
$$;

ALTER FUNCTION app.resolve_companion_device(text) OWNER TO jarvis_auth_runtime;
REVOKE EXECUTE ON FUNCTION app.resolve_companion_device(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_companion_device(text) TO jarvis_app_runtime;

-- The signed-in account's own devices. The filter is the owner check, so a second account
-- (admins included) sees none of them.
CREATE OR REPLACE VIEW app.companion_devices_owner AS
  SELECT d.id, d.user_id, d.display_name, d.platform, d.app_version, d.os_version,
         d.created_at, d.last_contact_at, d.expires_at, d.absolute_expires_at,
         (SELECT c.revision FROM app.companion_recording_capabilities c
           WHERE c.device_id = d.id AND c.revoked_at IS NULL) AS capability_revision
    FROM app.companion_devices d
   WHERE d.user_id = app.current_actor_user_id();

ALTER VIEW app.companion_devices_owner OWNER TO jarvis_auth_runtime;
REVOKE ALL ON app.companion_devices_owner FROM PUBLIC;
GRANT SELECT ON app.companion_devices_owner TO jarvis_app_runtime;

-- Heartbeat for the signed-in account's device. Returns false when the device is not theirs.
CREATE OR REPLACE FUNCTION app.companion_device_heartbeat(p_device uuid, p_app_version text, p_os_version text)
  RETURNS boolean
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = app, pg_temp
AS $$
  WITH u AS (
    UPDATE companion_devices d
       SET app_version = left(p_app_version, 32), os_version = left(p_os_version, 32),
           last_contact_at = now()
     WHERE d.id = p_device AND d.user_id = app.current_actor_user_id()
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

ALTER FUNCTION app.companion_device_heartbeat(uuid, text, text) OWNER TO jarvis_auth_runtime;
REVOKE EXECUTE ON FUNCTION app.companion_device_heartbeat(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.companion_device_heartbeat(uuid, text, text) TO jarvis_app_runtime;

-- Rename for the signed-in account's device. Returns false when the device is not theirs.
CREATE OR REPLACE FUNCTION app.companion_device_rename(p_device uuid, p_name text)
  RETURNS boolean
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = app, pg_temp
AS $$
  WITH u AS (
    UPDATE companion_devices d SET display_name = p_name
     WHERE d.id = p_device AND d.user_id = app.current_actor_user_id()
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

ALTER FUNCTION app.companion_device_rename(uuid, text) OWNER TO jarvis_auth_runtime;
REVOKE EXECUTE ON FUNCTION app.companion_device_rename(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.companion_device_rename(uuid, text) TO jarvis_app_runtime;
