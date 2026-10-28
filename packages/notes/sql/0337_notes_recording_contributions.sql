-- Canonical claims contain no file contents. Their availability probe returns one Boolean;
-- ordinary SELECT, including administrator reads, remains owner scoped.
CREATE TABLE app.notes_destination_bindings (
  destination_id TEXT PRIMARY KEY CHECK (destination_id ~ '^[a-f0-9]{64}$'),
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.notes_managed_actors(owner_user_id) ON DELETE CASCADE,
  side TEXT NOT NULL CHECK (side IN ('personal','work')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  UNIQUE(owner_user_id,destination_id)
);
ALTER TABLE app.notes_destination_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_destination_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_destination_bindings_owner ON app.notes_destination_bindings
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
CREATE POLICY notes_destination_bindings_probe ON app.notes_destination_bindings
  FOR SELECT TO jarvis_migration_owner USING (true);
CREATE FUNCTION app.notes_destination_available(destination TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app, pg_temp
AS $$
  SELECT app.current_actor_user_id() IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.notes_destination_bindings binding
    WHERE binding.destination_id = destination
      AND binding.owner_user_id <> app.current_actor_user_id()
  );
$$;
REVOKE ALL ON FUNCTION app.notes_destination_available(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.notes_destination_available(TEXT)
  TO jarvis_app_runtime,jarvis_worker_runtime;

CREATE TABLE app.notes_recording_contributions (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  receipt_id TEXT NOT NULL CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
  source_module_id TEXT NOT NULL CHECK (source_module_id='meetings'),
  source_id UUID NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  item_key TEXT NOT NULL CHECK (item_key ~ '^[a-zA-Z0-9_-]{1,80}$'),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  side TEXT NOT NULL CHECK (side IN ('personal','work')),
  state TEXT NOT NULL CHECK (state IN ('pending','applied','undone','conflict')),
  destination_id TEXT NOT NULL,
  destination JSONB NOT NULL CHECK (jsonb_typeof(destination)='object'),
  prose TEXT NOT NULL CHECK (octet_length(prose) BETWEEN 1 AND 16384),
  block_bytes TEXT NOT NULL CHECK (octet_length(block_bytes) BETWEEN 1 AND 17024),
  operation_id UUID,
  PRIMARY KEY(owner_user_id,receipt_id),
  UNIQUE(owner_user_id,source_module_id,source_id,source_version,item_key),
  FOREIGN KEY(owner_user_id,source_module_id,source_id)
    REFERENCES app.notes_managed_sources(owner_user_id,source_module_id,source_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id,destination_id)
    REFERENCES app.notes_destination_bindings(owner_user_id,destination_id),
  CHECK (destination->>'id'=destination_id),
  CHECK (state NOT IN ('pending','conflict') OR operation_id IS NOT NULL)
);
CREATE INDEX notes_recording_contributions_destination
  ON app.notes_recording_contributions(owner_user_id,destination_id);

CREATE TABLE app.notes_contribution_proposals (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  proposal_id UUID NOT NULL,
  source_module_id TEXT NOT NULL,
  source_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,proposal_id),
  FOREIGN KEY(owner_user_id,source_module_id,source_id)
    REFERENCES app.notes_managed_sources(owner_user_id,source_module_id,source_id) ON DELETE CASCADE
);

CREATE TABLE app.notes_contribution_operations (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  operation_id UUID NOT NULL,
  receipt_id TEXT NOT NULL,
  source_module_id TEXT NOT NULL,
  source_id UUID NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','conflict','applied')),
  destination_ids TEXT[] NOT NULL CHECK (cardinality(destination_ids) BETWEEN 1 AND 2),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  PRIMARY KEY(owner_user_id,operation_id),
  FOREIGN KEY(owner_user_id,operation_id)
    REFERENCES app.notes_contribution_proposals(owner_user_id,proposal_id) ON DELETE CASCADE,
  FOREIGN KEY(owner_user_id,receipt_id)
    REFERENCES app.notes_recording_contributions(owner_user_id,receipt_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX notes_contribution_operations_one_pending_source
  ON app.notes_contribution_operations(owner_user_id,source_module_id,source_id)
  WHERE state IN ('pending','conflict');

ALTER TABLE app.notes_recording_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_recording_contributions FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_recording_contributions_owner ON app.notes_recording_contributions
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
ALTER TABLE app.notes_contribution_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_contribution_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_contribution_proposals_owner ON app.notes_contribution_proposals
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
ALTER TABLE app.notes_contribution_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes_contribution_operations FORCE ROW LEVEL SECURITY;
CREATE POLICY notes_contribution_operations_owner ON app.notes_contribution_operations
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON app.notes_destination_bindings,
  app.notes_recording_contributions,app.notes_contribution_proposals,
  app.notes_contribution_operations TO jarvis_app_runtime,jarvis_worker_runtime;
