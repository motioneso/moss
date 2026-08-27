-- Story-level relevance feedback: News/Sports story targets, More/Less directions,
-- a bounded reason for "Less like this", revisions, and the superseded lifecycle state (#2016).
--
-- 0120 created the base tables with unnamed inline CHECK constraints. Widening a CHECK means
-- dropping and re-adding it, and 0120 must never be edited (the runner hash-checks applied files).
-- The drop below matches constraints by the column they constrain rather than by generated name,
-- so it cannot accidentally take out the length check on target_ref or the shape check on
-- metadata_json.

DO $$
DECLARE
  spec record;
  doomed record;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('app.usefulness_feedback_signals', 'target_kind'),
      ('app.usefulness_feedback_signals', 'surface'),
      ('app.usefulness_feedback_signals', 'kind'),
      ('app.usefulness_feedback_signals', 'status'),
      ('app.usefulness_feedback_targets', 'target_kind'),
      ('app.usefulness_feedback_targets', 'surface')
    ) AS t(table_name, column_name)
  LOOP
    FOR doomed IN
      SELECT c.conname
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid = c.conrelid
       AND a.attname = spec.column_name
       AND NOT a.attisdropped
      WHERE c.conrelid = spec.table_name::regclass
        AND c.contype = 'c'
        AND c.conkey = ARRAY[a.attnum]
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', spec.table_name, doomed.conname);
    END LOOP;
  END LOOP;
END
$$;

ALTER TABLE app.usefulness_feedback_signals
  ADD COLUMN IF NOT EXISTS reason_text text,
  ADD COLUMN IF NOT EXISTS rule_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS rule_version integer,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE app.usefulness_feedback_signals
  ADD CONSTRAINT usefulness_feedback_signals_target_kind_allowed CHECK (
    target_kind IN (
      'chat_message',
      'briefing_run',
      'briefing_item',
      'proactive_card',
      'news_story',
      'sports_story'
    )
  ),
  ADD CONSTRAINT usefulness_feedback_signals_surface_allowed CHECK (
    surface IN ('chat', 'briefing', 'today', 'proactive', 'news', 'sports')
  ),
  ADD CONSTRAINT usefulness_feedback_signals_kind_allowed CHECK (
    kind IN (
      'more_like_this',
      'less_like_this',
      'too_much',
      'wrong_priority',
      'not_useful',
      'remember_this',
      'dismiss'
    )
  ),
  ADD CONSTRAINT usefulness_feedback_signals_status_allowed CHECK (
    status IN ('active', 'undone', 'superseded')
  ),
  ADD CONSTRAINT usefulness_feedback_signals_rule_json_object CHECK (
    jsonb_typeof(rule_json) = 'object'
  ),
  ADD CONSTRAINT usefulness_feedback_signals_revision_positive CHECK (revision >= 1),
  ADD CONSTRAINT usefulness_feedback_signals_reason_text_bounded CHECK (
    reason_text IS NULL OR length(reason_text) <= 500
  ),
  -- A reason is required exactly for "Less like this" and refused for every other action.
  ADD CONSTRAINT usefulness_feedback_signals_reason_matches_kind CHECK (
    (kind = 'less_like_this' AND reason_text IS NOT NULL AND btrim(reason_text) <> '')
    OR (kind <> 'less_like_this' AND reason_text IS NULL)
  );

ALTER TABLE app.usefulness_feedback_targets
  ADD CONSTRAINT usefulness_feedback_targets_target_kind_allowed CHECK (
    target_kind IN (
      'chat_message',
      'briefing_run',
      'briefing_item',
      'proactive_card',
      'news_story',
      'sports_story'
    )
  ),
  ADD CONSTRAINT usefulness_feedback_targets_surface_allowed CHECK (
    surface IN ('chat', 'briefing', 'today', 'proactive', 'news', 'sports')
  );

-- The 0120 dedupe index includes the action, so it cannot stop one story holding both
-- directions at once. Story preferences are one-per-story across both directions.
CREATE UNIQUE INDEX IF NOT EXISTS usefulness_feedback_signals_active_story_idx
  ON app.usefulness_feedback_signals (owner_user_id, target_kind, target_ref)
  WHERE status = 'active' AND target_kind IN ('news_story', 'sports_story');
