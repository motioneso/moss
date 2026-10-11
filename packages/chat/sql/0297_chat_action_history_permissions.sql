-- Late action outcomes update only owned assistant metadata, never message prose or identity.
-- Keep 0057's worker-only chat_messages_update policy and the absence of a table-wide app UPDATE.
GRANT UPDATE (tool_metadata, updated_at) ON app.chat_messages TO jarvis_app_runtime;

CREATE POLICY chat_messages_action_history_update
ON app.chat_messages
FOR UPDATE
TO jarvis_app_runtime
USING (
  owner_user_id = app.current_actor_user_id()
  AND role = 'assistant'
  AND status = 'stored'
  AND EXISTS (
    SELECT 1 FROM app.chat_threads thread
    WHERE thread.id = chat_messages.thread_id
      AND thread.owner_user_id = app.current_actor_user_id()
      AND NOT thread.incognito
  )
)
WITH CHECK (
  owner_user_id = app.current_actor_user_id()
  AND role = 'assistant'
  AND status = 'stored'
  AND EXISTS (
    SELECT 1 FROM app.chat_threads thread
    WHERE thread.id = chat_messages.thread_id
      AND thread.owner_user_id = app.current_actor_user_id()
      AND NOT thread.incognito
  )
);

-- A terminal event may arrive before its originating turn is saved. Only the exact metadata-only
-- shape written by ChatRepository may have no prose. COALESCE is deliberate: CHECK(NULL) passes.
ALTER TABLE app.chat_messages DROP CONSTRAINT chat_messages_body_check;
ALTER TABLE app.chat_messages ADD CONSTRAINT chat_messages_body_check CHECK (
  (length(btrim(body)) > 0 AND NOT (tool_metadata ? 'actionOutcomeHidden'))
  OR COALESCE((
    body = ''
    AND role = 'assistant'
    AND status = 'stored'
    AND model_metadata = '{}'::jsonb
    AND tool_metadata->'actionOutcomeOnly' = 'true'::jsonb
    AND tool_metadata->'selectedTools' = '[]'::jsonb
    AND (NOT (tool_metadata ? 'actionOutcomeHidden') OR tool_metadata->'actionOutcomeHidden' = 'true'::jsonb)
    AND (tool_metadata - ARRAY['actionOutcomeOnly', 'actionOutcomeHidden', 'selectedTools', 'activity', 'actionResults']) = '{}'::jsonb
    AND tool_metadata->'actionResults' = tool_metadata->'activity'
    AND CASE WHEN jsonb_typeof(tool_metadata->'activity') = 'array' THEN
      jsonb_array_length(tool_metadata->'activity') = 1
      AND CASE WHEN jsonb_typeof(tool_metadata->'activity'->0) = 'object' THEN
        tool_metadata->'activity'->0->>'kind' = 'action_result'
        AND jsonb_typeof(tool_metadata->'activity'->0->'actionRequestId') = 'string'
        AND length(btrim(tool_metadata->'activity'->0->>'actionRequestId')) > 0
        AND jsonb_typeof(tool_metadata->'activity'->0->'text') = 'string'
        AND length(tool_metadata->'activity'->0->>'text') <= 200
        AND tool_metadata->'activity'->0->>'outcome' IN ('executed', 'denied', 'error', 'allowed')
        AND ((tool_metadata->'activity'->0) - ARRAY[
          'kind', 'actionRequestId', 'text', 'outcome', 'toolName', 'summary', 'reason',
          'decidedBy', 'sequence', 'durationMs'
        ]) = '{}'::jsonb
        AND (NOT (tool_metadata->'activity'->0 ? 'toolName') OR (
          jsonb_typeof(tool_metadata->'activity'->0->'toolName') = 'string'
          AND length(tool_metadata->'activity'->0->>'toolName') <= 120
        ))
        AND (NOT (tool_metadata->'activity'->0 ? 'summary') OR (
          jsonb_typeof(tool_metadata->'activity'->0->'summary') = 'string'
          AND length(tool_metadata->'activity'->0->>'summary') <= 200
        ))
        AND (NOT (tool_metadata->'activity'->0 ? 'reason') OR (
          jsonb_typeof(tool_metadata->'activity'->0->'reason') = 'string'
          AND length(tool_metadata->'activity'->0->>'reason') <= 500
        ))
        AND (NOT (tool_metadata->'activity'->0 ? 'decidedBy') OR (
          tool_metadata->'activity'->0->>'decidedBy' IN ('person', 'policy', 'timeout', 'cancelled')
        ))
        AND (NOT (tool_metadata->'activity'->0 ? 'sequence') OR (
          jsonb_typeof(tool_metadata->'activity'->0->'sequence') = 'number'
        ))
        AND (NOT (tool_metadata->'activity'->0 ? 'durationMs') OR (
          jsonb_typeof(tool_metadata->'activity'->0->'durationMs') = 'number'
        ))
      ELSE false END
    ELSE false END
  ), false)
);

-- Absorbed synthetic rows remain stored and are hidden using the existing metadata-only UPDATE.
-- App runtime never receives DELETE on chat_messages.
