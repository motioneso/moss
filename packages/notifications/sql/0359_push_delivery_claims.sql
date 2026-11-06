-- #3477: commit send admission before releasing source lifecycle locks.
-- No notification content or device credentials are stored here.
CREATE TABLE app.push_delivery_claims (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  delivery_key text NOT NULL,
  token uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, delivery_key)
);

ALTER TABLE app.push_delivery_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.push_delivery_claims FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.push_delivery_claims
  TO jarvis_app_runtime, jarvis_worker_runtime;
CREATE POLICY push_delivery_claims_owner ON app.push_delivery_claims
  FOR ALL TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
