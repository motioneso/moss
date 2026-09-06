-- #2237 Photos for stories from custom sources (global migration 0222; planned as 0214, renumbered at landing).
-- Slice 2 adds the per-source photo record to app.sports_custom_sources: the verified photo rule
-- Moss may propose later (slice 3), the rule's lifecycle state, and the counters the refresh path
-- writes so the settings row can say whether photos are working without re-reading any story.
--
-- The user-facing statuses ("Photos: working", "none found", "checking", "preview ready",
-- "stopped working") are derived from these columns, never stored: a derived status cannot drift
-- away from the record the refresh actually wrote.
--
-- RLS: unchanged. These columns sit on rows already under owner-only FORCE RLS from 0190, so the
-- existing policies cover them. The worker's column-scoped SELECT from 0191 gains only the two
-- status columns, because the background export builder runs as the worker and the export carries
-- them. photo_rule_json is never granted: the saved instruction is owner data, read only inside
-- the owner's own data context.

ALTER TABLE app.sports_custom_sources
  ADD COLUMN photo_rule_json jsonb
    CHECK (photo_rule_json IS NULL OR jsonb_typeof(photo_rule_json) = 'object'),
  ADD COLUMN photo_rule_state text NOT NULL DEFAULT 'none'
    CHECK (photo_rule_state IN ('none', 'previewing', 'in_use', 'stale')),
  ADD COLUMN photo_miss_streak smallint NOT NULL DEFAULT 0
    CHECK (photo_miss_streak >= 0),
  ADD COLUMN photo_last_outcome text
    CHECK (photo_last_outcome IS NULL OR photo_last_outcome IN ('working', 'none')),
  ADD COLUMN photo_relook_at timestamptz;

-- A rule only exists once Moss has proposed one and the owner has confirmed it, so a state that
-- implies a rule must have one, and a state that implies none must not.
ALTER TABLE app.sports_custom_sources
  ADD CONSTRAINT sports_custom_sources_photo_rule_shape_check
    CHECK ((photo_rule_state = 'none' AND photo_rule_json IS NULL)
           OR (photo_rule_state IN ('previewing', 'in_use', 'stale')
               AND (photo_rule_state = 'previewing' OR photo_rule_json IS NOT NULL)));

-- The background export builder runs as the worker role, and 0191 grants that role a
-- column-by-column SELECT: a column missing from the list makes the whole export fail.
GRANT SELECT (photo_rule_state, photo_last_outcome)
  ON app.sports_custom_sources TO jarvis_worker_runtime;
