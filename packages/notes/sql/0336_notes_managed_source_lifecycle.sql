-- Managed publication metadata only; filesystem contribution cleanup is composed by owning services.
CREATE TABLE app.notes_managed_actors (
  owner_user_id UUID PRIMARY KEY DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleting','sealed')),
  operation_id UUID,
  CHECK ((state = 'active' AND operation_id IS NULL) OR
    (state <> 'active' AND operation_id IS NOT NULL))
);

CREATE TABLE app.notes_managed_sources (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.notes_managed_actors(owner_user_id) ON DELETE CASCADE,
  source_module_id TEXT NOT NULL CHECK (source_module_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  source_id UUID NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','deleting','sealed')),
  operation_id UUID,
  PRIMARY KEY (owner_user_id,source_module_id,source_id),
  CHECK ((state = 'active' AND operation_id IS NULL) OR
    (state <> 'active' AND operation_id IS NOT NULL))
);

ALTER TABLE app.notes_managed_actors ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_managed_actors FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_managed_actors_owner ON app.notes_managed_actors
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());

ALTER TABLE app.notes_managed_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_managed_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_managed_sources_owner ON app.notes_managed_sources
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());

GRANT SELECT,INSERT,UPDATE,DELETE ON app.notes_managed_actors,app.notes_managed_sources
  TO jarvis_app_runtime,jarvis_worker_runtime;
