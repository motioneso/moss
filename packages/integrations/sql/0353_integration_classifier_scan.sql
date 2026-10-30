-- #3844 slice 1: scan storage on the owner's connection row.
--
-- classifier_scan is a versioned JSON map holding, per tool, the actions the scan found, and,
-- per listing source, the target lists the scan read. It starts empty. Code converts the old
-- sort, send and preparation maps into it; the migration only adds storage. RLS is unchanged:
-- the row is already owner-only for every actor, administrators included, and this column
-- inherits that policy. Deleting a connection deletes the map with the row.
ALTER TABLE app.integration_connections
  ADD COLUMN classifier_scan jsonb NOT NULL DEFAULT '{"version": 1, "actions": {}, "targets": {}}'::jsonb;

ALTER TABLE app.integration_connections
  ADD CONSTRAINT integration_connections_classifier_scan_object
  CHECK (jsonb_typeof(classifier_scan) = 'object');
