ALTER TABLE app.workshop_projects
  ADD COLUMN feed_sequence BIGINT NOT NULL DEFAULT 0 CHECK (feed_sequence >= 0),
  ADD CONSTRAINT workshop_projects_id_owner UNIQUE (id, owner_user_id);

CREATE TABLE app.workshop_project_feed (
  project_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  message_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL DEFAULT 'user_message' CHECK (kind = 'user_message'),
  text TEXT NOT NULL CHECK (octet_length(text) BETWEEN 1 AND 16384 AND btrim(text) <> ''),
  delivery TEXT NOT NULL DEFAULT 'pending' CHECK (delivery = 'pending'),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, message_id),
  UNIQUE (project_id, sequence),
  FOREIGN KEY (project_id, owner_user_id)
    REFERENCES app.workshop_projects(id, owner_user_id) ON DELETE CASCADE
);

CREATE INDEX workshop_project_feed_owner ON app.workshop_project_feed (owner_user_id);
ALTER TABLE app.workshop_project_feed ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.workshop_project_feed FORCE ROW LEVEL SECURITY;
CREATE POLICY workshop_project_feed_owner ON app.workshop_project_feed
  FOR ALL TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT ON app.workshop_project_feed TO jarvis_app_runtime;
GRANT SELECT ON app.workshop_project_feed TO jarvis_worker_runtime;
GRANT UPDATE (feed_sequence, updated_at) ON app.workshop_projects TO jarvis_app_runtime;
