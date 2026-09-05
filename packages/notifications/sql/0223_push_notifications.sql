-- Migration 0223: Web push subscriptions and signing key (Issue #743 / #2227)

CREATE TABLE IF NOT EXISTS app.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  -- Security review 1, finding 2: the push endpoint URL and the browser's encryption keys
  -- are bearer credentials (anyone holding them can push to that device), so they never sit
  -- in plaintext columns. The row keeps only a sha256 of the endpoint for uniqueness and an
  -- AES-256-GCM envelope of {endpoint, p256dh, auth}, opened by the delivery worker.
  endpoint_hash text NOT NULL,
  credentials_ciphertext jsonb NOT NULL,
  user_agent_label text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  failure_count integer NOT NULL DEFAULT 0,
  disabled_at timestamptz,
  -- Security review 1, finding 8: the key of the last payload delivered to this device
  -- (a notification id, or summary:<release time>). A pg-boss retry of the same job skips
  -- devices that already hold its key, so a retried delivery never repeats a success.
  last_delivered_key text,
  CONSTRAINT push_subscriptions_owner_endpoint_key UNIQUE (owner_user_id, endpoint_hash)
);

CREATE INDEX IF NOT EXISTS push_subscriptions_owner_user_id_idx
  ON app.push_subscriptions(owner_user_id);

CREATE TABLE IF NOT EXISTS app.push_signing_key (
  id text PRIMARY KEY CHECK (id = 'default'),
  public_key text NOT NULL,
  private_key_ciphertext jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app.push_subscriptions TO jarvis_app_runtime;
GRANT SELECT, UPDATE, DELETE ON app.push_subscriptions TO jarvis_worker_runtime;

GRANT SELECT, INSERT ON app.push_signing_key TO jarvis_app_runtime;
GRANT SELECT ON app.push_signing_key TO jarvis_worker_runtime;

ALTER TABLE app.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_subscriptions FORCE ROW LEVEL SECURITY;

ALTER TABLE app.push_signing_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_signing_key FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON app.push_subscriptions;
CREATE POLICY push_subscriptions_select ON app.push_subscriptions
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_insert ON app.push_subscriptions;
CREATE POLICY push_subscriptions_insert ON app.push_subscriptions
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_update ON app.push_subscriptions;
CREATE POLICY push_subscriptions_update ON app.push_subscriptions
  FOR UPDATE TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  )
  WITH CHECK (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_subscriptions_delete ON app.push_subscriptions;
CREATE POLICY push_subscriptions_delete ON app.push_subscriptions
  FOR DELETE TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    app.current_actor_user_id() IS NOT NULL
    AND owner_user_id = app.current_actor_user_id()
  );

DROP POLICY IF EXISTS push_signing_key_select ON app.push_signing_key;
CREATE POLICY push_signing_key_select ON app.push_signing_key
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (true);

DROP POLICY IF EXISTS push_signing_key_insert ON app.push_signing_key;
CREATE POLICY push_signing_key_insert ON app.push_signing_key
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (app.current_actor_user_id() IS NOT NULL);
