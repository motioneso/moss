-- #2984 classifier tools on by default, R2.1: per-tool sort storage on the owner's connection row.
--
-- classifier_sort is a versioned JSON map keyed by discovered tool name. Each entry holds the
-- sorting pass's result (sort status, risk group, readable name, sort fingerprint, sorted time),
-- the owner's send-without-asking choice and a risk floor converted from the old per-tool review.
-- classifier_kept_out_tools lists tools the owner kept out of the classifier; they stay on for
-- ordinary chat. RLS is unchanged: the row is already owner-only for every actor, administrators
-- included, and these columns inherit that policy. Deleting a connection deletes both.
ALTER TABLE app.integration_connections
  ADD COLUMN classifier_sort jsonb NOT NULL DEFAULT '{"version": 1, "entries": {}}'::jsonb,
  ADD COLUMN classifier_kept_out_tools text[] NOT NULL DEFAULT '{}';

ALTER TABLE app.integration_connections
  ADD CONSTRAINT integration_connections_classifier_sort_object
  CHECK (jsonb_typeof(classifier_sort) = 'object');
