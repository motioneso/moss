-- Only future completed messages create receipts; existing history starts read.
CREATE TABLE app.chat_unread_messages (
  message_id uuid PRIMARY KEY REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES app.chat_threads(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE
);
CREATE INDEX chat_unread_messages_owner_thread_idx
  ON app.chat_unread_messages(owner_user_id, thread_id);

ALTER TABLE app.chat_unread_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_unread_messages FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_unread_select ON app.chat_unread_messages FOR SELECT
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY chat_unread_insert ON app.chat_unread_messages FOR INSERT
  TO jarvis_app_runtime, jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND EXISTS (
    SELECT 1 FROM app.chat_messages m JOIN app.chat_threads t ON t.id = m.thread_id
    WHERE m.id = message_id AND m.thread_id = chat_unread_messages.thread_id
      AND m.owner_user_id = chat_unread_messages.owner_user_id
      AND t.owner_user_id = m.owner_user_id AND NOT t.incognito AND t.surface = 'drawer'
      AND m.role = 'assistant' AND m.status = 'stored' AND length(btrim(m.body)) > 0
  ));
CREATE POLICY chat_unread_delete ON app.chat_unread_messages FOR DELETE
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT, DELETE ON app.chat_unread_messages TO jarvis_app_runtime;
GRANT SELECT, INSERT ON app.chat_unread_messages TO jarvis_worker_runtime;

CREATE FUNCTION app.track_chat_unread_message() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, app AS $$
BEGIN
  IF NEW.role <> 'assistant' OR NEW.status <> 'stored' OR length(btrim(NEW.body)) = 0 THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.status = 'stored' THEN RETURN NEW; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM app.chat_threads t WHERE t.id = NEW.thread_id
    AND t.owner_user_id = NEW.owner_user_id AND NOT t.incognito AND t.surface = 'drawer') THEN
    INSERT INTO app.chat_unread_messages(message_id, thread_id, owner_user_id)
      VALUES (NEW.id, NEW.thread_id, NEW.owner_user_id) ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_messages_track_unread
AFTER INSERT OR UPDATE OF status ON app.chat_messages
FOR EACH ROW EXECUTE FUNCTION app.track_chat_unread_message();
