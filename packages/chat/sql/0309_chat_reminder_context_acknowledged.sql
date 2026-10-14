-- #3311: a stored Main model turn that was shown a delivered reminder acknowledges it.
-- Acknowledged reminders leave the per-owner cap, which already counts pending context only.
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_context_state_check;
ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_context_state_check
  CHECK (context_state IN ('pending', 'dismissed', 'acknowledged'));

-- Allowed moves, with every other column fixed:
--   queued -> delivered | failed      (worker; delivered needs its reserved message)
--   queued -> cancelled               (owner)
--   delivered/pending -> delivered/dismissed      (owner)
--   delivered/pending -> delivered/acknowledged   (stored Main model turn)
CREATE OR REPLACE FUNCTION app.enforce_chat_reminder_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
    OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
    OR NEW.reserved_message_id IS DISTINCT FROM OLD.reserved_message_id
    OR NEW.reminder_text IS DISTINCT FROM OLD.reminder_text
    OR NEW.delay_seconds IS DISTINCT FROM OLD.delay_seconds
    OR NEW.due_at IS DISTINCT FROM OLD.due_at
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat reminder identity cannot be changed';
  END IF;

  IF OLD.state = 'delivered' AND NEW.state = 'delivered' THEN
    IF OLD.context_state <> 'pending'
      OR NEW.context_state NOT IN ('dismissed', 'acknowledged')
      OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.late IS DISTINCT FROM OLD.late THEN
      RAISE EXCEPTION 'chat reminder context can only be dismissed or acknowledged once after delivery';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.context_state IS DISTINCT FROM OLD.context_state THEN
    RAISE EXCEPTION 'chat reminder identity cannot be changed';
  END IF;
  IF OLD.state <> 'queued' OR NEW.state NOT IN ('delivered', 'failed', 'cancelled') THEN
    RAISE EXCEPTION 'chat reminder can only be delivered once';
  END IF;
  IF NEW.state = 'delivered' AND NOT EXISTS (
    SELECT 1 FROM app.chat_messages message
    WHERE message.id = NEW.reserved_message_id
      AND message.thread_id = NEW.thread_id
      AND message.owner_user_id = NEW.owner_user_id
      AND message.role = 'assistant'
  ) THEN
    RAISE EXCEPTION 'chat reminder delivery needs its reserved message';
  END IF;
  RETURN NEW;
END;
$$;

-- The app may acknowledge only its own delivered, pending reminders in its own Main chat.
-- Permissive UPDATE policies are ORed, and the owner cancel policy admits any of the owner's
-- reminders, so the Main-chat check is repeated in WITH CHECK.
CREATE POLICY chat_reminders_acknowledge ON app.chat_reminders
  FOR UPDATE TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND state = 'delivered'
    AND context_state = 'pending'
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id
        AND thread.owner_user_id = app.current_actor_user_id()
        AND thread.is_main
    )
  )
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND state = 'delivered'
    AND context_state = 'acknowledged'
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id
        AND thread.owner_user_id = app.current_actor_user_id()
        AND thread.is_main
    )
  );
