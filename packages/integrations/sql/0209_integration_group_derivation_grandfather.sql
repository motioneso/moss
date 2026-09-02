-- #2175 Task 5 — one-time grandfathering for connections that predate derived groups.
--
-- Before this change, an empty enabled_tools list meant "everything not muted is live" for a
-- connection with no service-supplied groups. Once isGroupOptIn starts deriving groups for
-- over-threshold, all-blank-group connections, that same empty list would mean "nothing is live"
-- instead. This data-only step writes the currently-effective tool names into enabled_tools for
-- exactly the connections that would otherwise flip live tools off, so the moment the new opt-in
-- rule takes effect, its explicit list already matches what was live a moment before. It never
-- touches a connection that already has an explicit enabled_tools list, real service-supplied
-- groups, or is under the threshold — and it never re-adds a tool discovered later, since that
-- refresh runs after this one-time step.
UPDATE app.integration_connections
SET enabled_tools = (
  SELECT array_agg(t ->> 'name')
  FROM jsonb_array_elements(discovered_tools) AS t
  WHERE NOT (t ->> 'name' = ANY(muted_tools))
)
WHERE enabled_tools = '{}'
  AND jsonb_array_length(discovered_tools) > 30
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(discovered_tools) AS t
    WHERE COALESCE(t ->> 'group', '') <> ''
  );
