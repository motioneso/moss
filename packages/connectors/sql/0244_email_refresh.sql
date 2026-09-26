-- Durable owner-scoped email refresh requests, request-key aliases, and per-account dispatch.
-- Rows contain only status, timestamps, bounded error codes, and aggregate message counts.

ALTER TABLE app.connector_accounts
  ADD CONSTRAINT connector_accounts_id_owner_user_id_unique UNIQUE (id, owner_user_id);

CREATE TABLE app.connector_email_refreshes (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'no-eligible-accounts', 'no-active-connection', 'auth-error', 'email-error',
    'email-message-error', 'email-needs-config', 'enqueue-failed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (id, owner_user_id),
  CHECK ((status IN ('succeeded', 'partial', 'failed')) = (completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX connector_email_refreshes_one_active_per_owner
  ON app.connector_email_refreshes(owner_user_id)
  WHERE status IN ('queued', 'running');

CREATE TABLE app.connector_email_refresh_keys (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  refresh_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, idempotency_key),
  FOREIGN KEY (refresh_id, owner_user_id)
    REFERENCES app.connector_email_refreshes(id, owner_user_id) ON DELETE CASCADE
);

CREATE TABLE app.connector_email_refresh_accounts (
  refresh_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  account_id uuid NOT NULL,
  provider_type app.connector_provider_type NOT NULL CHECK (provider_type IN ('google', 'imap')),
  status text NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'partial', 'failed')),
  dispatch_status text NOT NULL DEFAULT 'pending' CHECK (dispatch_status IN ('pending', 'dispatched')),
  dispatch_attempts integer NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0),
  email_upserted integer NOT NULL DEFAULT 0 CHECK (email_upserted >= 0),
  email_failures integer NOT NULL DEFAULT 0 CHECK (email_failures >= 0),
  error_code text CHECK (error_code IS NULL OR error_code IN (
    'no-eligible-accounts', 'no-active-connection', 'auth-error', 'email-error',
    'email-message-error', 'email-needs-config', 'enqueue-failed'
  )),
  started_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (refresh_id, account_id),
  FOREIGN KEY (refresh_id, owner_user_id)
    REFERENCES app.connector_email_refreshes(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (account_id, owner_user_id)
    REFERENCES app.connector_accounts(id, owner_user_id),
  CHECK ((status IN ('succeeded', 'partial', 'failed')) = (completed_at IS NOT NULL))
);

CREATE INDEX connector_email_refresh_accounts_pending_dispatch
  ON app.connector_email_refresh_accounts(owner_user_id, refresh_id)
  WHERE dispatch_status = 'pending' AND status = 'queued';

ALTER TABLE app.connector_email_refreshes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_email_refreshes FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connector_email_refresh_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_email_refresh_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connector_email_refresh_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_email_refresh_accounts FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON app.connector_email_refreshes
  TO jarvis_app_runtime, jarvis_worker_runtime;
GRANT SELECT, INSERT ON app.connector_email_refresh_keys TO jarvis_app_runtime;
GRANT SELECT, INSERT ON app.connector_email_refresh_accounts TO jarvis_app_runtime;
GRANT UPDATE (dispatch_status, dispatch_attempts, status, error_code, completed_at)
  ON app.connector_email_refresh_accounts TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.connector_email_refresh_accounts TO jarvis_worker_runtime;

CREATE POLICY connector_email_refreshes_owner_all
ON app.connector_email_refreshes FOR ALL
TO jarvis_app_runtime, jarvis_worker_runtime
USING (owner_user_id = app.current_actor_user_id())
WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY connector_email_refresh_keys_owner_all
ON app.connector_email_refresh_keys FOR ALL
TO jarvis_app_runtime
USING (owner_user_id = app.current_actor_user_id())
WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY connector_email_refresh_accounts_owner_all
ON app.connector_email_refresh_accounts FOR ALL
TO jarvis_app_runtime, jarvis_worker_runtime
USING (owner_user_id = app.current_actor_user_id())
WITH CHECK (owner_user_id = app.current_actor_user_id());

-- The periodic dispatcher sees only actor IDs with queued, pending metadata rows. It does
-- not enumerate account IDs or refresh contents; dispatch workers then enter owner context.
CREATE POLICY connector_email_refresh_accounts_migration_owner_select
ON app.connector_email_refresh_accounts FOR SELECT
TO jarvis_migration_owner
USING (true);

CREATE FUNCTION app.list_connector_email_refresh_dispatch_actors()
RETURNS TABLE(actor_user_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT DISTINCT owner_user_id
  FROM app.connector_email_refresh_accounts
  WHERE status = 'queued'
    AND dispatch_status = 'pending'
    AND dispatch_attempts < 3
  ORDER BY owner_user_id
  LIMIT 500;
$$;

REVOKE ALL ON FUNCTION app.list_connector_email_refresh_dispatch_actors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_connector_email_refresh_dispatch_actors()
  TO jarvis_worker_runtime;
