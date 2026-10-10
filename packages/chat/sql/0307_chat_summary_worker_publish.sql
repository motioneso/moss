-- The conversation summary job runs as jarvis_worker_runtime and publishes by
-- locking the thread row and updating its three summary columns. 0036 gave the
-- worker SELECT only, so the publish failed with "permission denied for table
-- chat_threads".
--
-- The grant covers only the summary columns. The policy is owner-only because the job
-- runs as the thread owner, so shares never let a worker write another owner's
-- thread.

GRANT UPDATE (conversation_summary, summary_covered_through_message_id, summary_revision)
ON app.chat_threads
TO jarvis_worker_runtime;

DROP POLICY IF EXISTS chat_threads_worker_summary_update ON app.chat_threads;
CREATE POLICY chat_threads_worker_summary_update
ON app.chat_threads
FOR UPDATE
TO jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
)
WITH CHECK (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
