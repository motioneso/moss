-- #2984 classifier tools on by default, R2.2: the background sorting job writes its results.
--
-- The worker role could only read connections. It now gets UPDATE on the two columns the sort
-- writes and nothing else, under an owner-scoped policy: a job enters its owner's data context
-- and can touch only that owner's rows. RLS still applies to every actor; no role bypasses it.
GRANT UPDATE (classifier_sort, updated_at) ON app.integration_connections TO jarvis_worker_runtime;

CREATE POLICY integration_connections_worker_sort ON app.integration_connections
  FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

-- The start-up sweep sees only owner and connection ids for connections with a tool that has no
-- sort yet. It reads no tool text, credential or address; each job then enters owner context.
-- The definer's role needs its own read policy on this FORCE RLS table, and that policy is never
-- granted to a runtime role.
CREATE POLICY integration_connections_migration_owner_select
  ON app.integration_connections FOR SELECT
  TO jarvis_migration_owner
  USING (true);

CREATE FUNCTION app.list_integration_connections_needing_sort()
RETURNS TABLE(owner_user_id uuid, connection_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT c.owner_user_id, c.id
  FROM app.integration_connections AS c
  WHERE jsonb_typeof(c.discovered_tools) = 'array'
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(c.discovered_tools) AS t(tool)
      WHERE jsonb_typeof(t.tool) = 'object'
        AND coalesce(
          c.classifier_sort -> 'entries' -> (t.tool ->> 'name') ->> 'status',
          'never_tried'
        ) NOT IN ('current', 'failed')
    )
  ORDER BY c.owner_user_id, c.id
  LIMIT 1000;
$$;

REVOKE ALL ON FUNCTION app.list_integration_connections_needing_sort() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_integration_connections_needing_sort()
  TO jarvis_worker_runtime;
