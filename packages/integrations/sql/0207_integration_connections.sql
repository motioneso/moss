CREATE TABLE app.integration_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('mcp', 'openapi')),
  transport text NOT NULL DEFAULT 'http' CHECK (transport IN ('http')),
  url text NOT NULL,
  credential jsonb,
  credential_placement jsonb,
  enabled boolean NOT NULL DEFAULT true,
  base_url text,
  spec_pasted boolean NOT NULL DEFAULT false,
  enabled_groups text[] NOT NULL DEFAULT '{}',
  enabled_tools text[] NOT NULL DEFAULT '{}',
  muted_tools text[] NOT NULL DEFAULT '{}',
  discovered_tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_discovery_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, name)
);

ALTER TABLE app.integration_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.integration_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY integration_connections_owner ON app.integration_connections
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

CREATE POLICY integration_connections_worker_read ON app.integration_connections
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.integration_connections TO jarvis_app_runtime;
GRANT SELECT ON app.integration_connections TO jarvis_worker_runtime;
