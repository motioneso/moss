CREATE TABLE app.workshop_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  request_key UUID NOT NULL,
  title TEXT NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 160 AND btrim(title) <> ''),
  initial_request TEXT NOT NULL
    CHECK (octet_length(initial_request) BETWEEN 1 AND 16384 AND btrim(initial_request) <> ''),
  context TEXT NOT NULL DEFAULT '' CHECK (octet_length(context) <= 16384),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, request_key)
);

CREATE INDEX workshop_projects_owner_created
  ON app.workshop_projects (owner_user_id, created_at DESC, id DESC);

ALTER TABLE app.workshop_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workshop_projects FORCE ROW LEVEL SECURITY;

CREATE POLICY workshop_projects_owner ON app.workshop_projects
  FOR ALL TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT ON app.workshop_projects TO jarvis_app_runtime;
GRANT SELECT ON app.workshop_projects TO jarvis_worker_runtime;
