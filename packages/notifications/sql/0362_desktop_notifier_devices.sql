-- A keyed notification that fires again must alert again, so desktop acceptance is refreshed
-- in place and counts only when it is newer than the notification's last update.
GRANT UPDATE ON app.desktop_notification_receipts TO jarvis_app_runtime;

-- One registered notifier per account and desktop client. The notifier is a separate program
-- that keeps alerting after the app window is closed. It holds a random token that opens only
-- the desktop notice routes; the token itself is never stored, only its SHA-256.
CREATE TABLE app.desktop_notifier_devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  client_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  UNIQUE (user_id, client_id)
);

ALTER TABLE app.desktop_notifier_devices ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.desktop_notifier_devices TO jarvis_app_runtime;
CREATE POLICY desktop_notifier_devices_owner ON app.desktop_notifier_devices
  TO jarvis_app_runtime
  USING (user_id = app.current_actor_user_id())
  WITH CHECK (user_id = app.current_actor_user_id());

-- Resolves a presented token to its account before any actor is known. The table owner is not
-- subject to the policy above, so this is the only way to look a device up by token.
CREATE OR REPLACE FUNCTION app.resolve_notifier_device(p_hash text, p_client uuid)
  RETURNS TABLE(user_id uuid)
  LANGUAGE sql
  VOLATILE
  SECURITY DEFINER
  SET search_path = app, pg_temp
AS $$
  UPDATE desktop_notifier_devices d
     SET last_used_at = now()
   WHERE d.token_hash = p_hash AND d.client_id = p_client
  RETURNING d.user_id
$$;

REVOKE EXECUTE ON FUNCTION app.resolve_notifier_device(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.resolve_notifier_device(text, uuid) TO jarvis_app_runtime;
