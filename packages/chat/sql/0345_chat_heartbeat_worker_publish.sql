-- The heartbeat beat job runs as the worker role and writes the check-in into the owner's Main
-- chat. The worker could not insert chat messages except for reminders and module notices, so each
-- heartbeat message is allowed only for its own unfinished occurrence, and the worker may create
-- the owner's Main thread when none exists yet.

GRANT INSERT ON app.chat_threads TO jarvis_worker_runtime;

DROP POLICY IF EXISTS chat_threads_insert_heartbeat_main ON app.chat_threads;
CREATE POLICY chat_threads_insert_heartbeat_main
ON app.chat_threads
FOR INSERT
TO jarvis_worker_runtime
WITH CHECK (
  owner_user_id = app.current_actor_user_id()
  AND is_main
  AND surface = 'drawer'
  AND NOT incognito
  AND title = 'Main'
);

DROP POLICY IF EXISTS chat_messages_insert_heartbeat ON app.chat_messages;
CREATE POLICY chat_messages_insert_heartbeat
ON app.chat_messages
FOR INSERT
TO jarvis_worker_runtime
WITH CHECK (
  owner_user_id = app.current_actor_user_id()
  AND role = 'assistant'
  AND status = 'stored'
  AND (model_metadata -> 'origin' ->> 'kind') = 'heartbeat'
  AND (model_metadata -> 'origin' ->> 'version') = '1'
  AND EXISTS (
    SELECT 1
    FROM app.chat_threads t
    WHERE t.id = chat_messages.thread_id
      AND t.owner_user_id = app.current_actor_user_id()
      AND t.is_main
      AND t.surface = 'drawer'
      AND NOT t.incognito
  )
  AND EXISTS (
    SELECT 1
    FROM app.heartbeat_occurrences o
    WHERE o.id::text = (chat_messages.model_metadata -> 'origin' ->> 'occurrenceId')
      AND o.owner_user_id = app.current_actor_user_id()
      AND o.finished_at IS NULL
  )
);
