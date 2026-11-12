-- The IMAP sync removes cached messages that the mail server no longer lists. Only the
-- owner may delete a cached message, and a share never grants delete.
GRANT DELETE ON app.email_messages TO jarvis_app_runtime, jarvis_worker_runtime;

DROP POLICY IF EXISTS email_messages_delete ON app.email_messages;
CREATE POLICY email_messages_delete
ON app.email_messages
FOR DELETE
TO jarvis_app_runtime, jarvis_worker_runtime
USING (
  app.current_actor_user_id() IS NOT NULL
  AND owner_user_id = app.current_actor_user_id()
);
