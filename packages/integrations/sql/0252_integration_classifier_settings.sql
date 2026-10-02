-- #2884 classifier gate 2b.2 — owner storage for connected-tool classifier opt-in.
--
-- Two columns on the existing owner-only connection row: a per-connection classifier switch
-- (default off) and a versioned JSON map of owner-reviewed per-tool preparation, keyed by the
-- discovered tool name. RLS is unchanged: the row is already owner-only for every actor,
-- administrators included, and these columns inherit that policy. Deleting a connection still
-- cascades, taking its prepared text with it.
ALTER TABLE app.integration_connections
  ADD COLUMN classifier_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN classifier_preparation jsonb NOT NULL DEFAULT '{"version": 1, "entries": {}}'::jsonb;

ALTER TABLE app.integration_connections
  ADD CONSTRAINT integration_connections_classifier_preparation_object
  CHECK (jsonb_typeof(classifier_preparation) = 'object');
