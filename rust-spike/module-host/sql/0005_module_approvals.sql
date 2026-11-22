-- Durable, owner-scoped module approvals (JS-399). A module proposes a change now and the
-- account confirms it later over HTTP, so a record must survive the turn that created it,
-- unlike the in-memory chat approval book. The port mirrors the TypeScript
-- DayPlanChangeApprovalPort over app.ai_assistant_action_requests.
-- The table is host-owned: no module owns it, no db-port resource can reach it, and only the
-- approvals port writes it. Row security is the whole scoping story: every policy is owner-only
-- (actor equality, never an admin clause), so another account sees nothing, not even an
-- existence difference, and there is no admin bypass.
CREATE SCHEMA IF NOT EXISTS moss_modules;
REVOKE ALL ON SCHEMA moss_modules FROM PUBLIC;
GRANT USAGE ON SCHEMA moss_modules TO jarvis_app_runtime;
CREATE TABLE IF NOT EXISTS moss_modules.approvals (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  module_id text NOT NULL CHECK (length(btrim(module_id)) > 0),
  resource text NOT NULL CHECK (length(btrim(resource)) > 0),
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'cancelled')),
  input_summary jsonb NOT NULL CHECK (jsonb_typeof(input_summary) = 'object'),
  requested_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (status = 'pending' AND resolved_at IS NULL)
    OR (status <> 'pending' AND resolved_at IS NOT NULL)
  )
);
ALTER TABLE moss_modules.approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE moss_modules.approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS approvals_owner ON moss_modules.approvals;
CREATE POLICY approvals_owner ON moss_modules.approvals TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, UPDATE ON moss_modules.approvals TO jarvis_app_runtime;
