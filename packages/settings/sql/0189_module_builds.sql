-- #1754: a module build in progress — the plan, status, cost and fetched-URL trail a chat
-- turn writes to start one. Owner-only, no admin bypass (CLAUDE.md hard invariant).
CREATE TABLE app.module_builds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  conversation_id uuid NULL,
  status text NOT NULL CHECK (status IN ('planning','awaiting_plan_approval','building','awaiting_change','ready','failed','cancelled')),
  plan jsonb NULL,
  step text NULL,
  module_id text NULL REFERENCES app.external_modules(id) ON DELETE SET NULL,
  fetched_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_cents integer NOT NULL DEFAULT 0,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX module_builds_owner_idx ON app.module_builds (owner_user_id, status);

GRANT SELECT, INSERT, UPDATE ON app.module_builds TO jarvis_app_runtime;

ALTER TABLE app.module_builds ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.module_builds FORCE ROW LEVEL SECURITY;

CREATE POLICY module_builds_select
ON app.module_builds
FOR SELECT
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY module_builds_insert
ON app.module_builds
FOR INSERT
TO jarvis_app_runtime
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);

CREATE POLICY module_builds_update
ON app.module_builds
FOR UPDATE
TO jarvis_app_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
