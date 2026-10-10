-- #3310: the owner can cancel a queued reminder, or dismiss the pending context of one that
-- was already delivered. Both moves free the reminder's slot. Delivery stays worker-only.
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_state_check;
ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_state_check
  CHECK (state IN ('queued', 'delivered', 'failed', 'cancelled'));

ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_context_state_check;
ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_context_state_check
  CHECK (context_state IN ('pending', 'dismissed'));

ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_dismissed_only_when_delivered
  CHECK (context_state <> 'dismissed' OR state = 'delivered');

-- Allowed moves, with every other column fixed:
--   queued -> delivered | failed      (worker; delivered needs its reserved message)
--   queued -> cancelled               (owner)
--   delivered/pending -> delivered/dismissed  (owner)
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
    IF OLD.context_state <> 'pending' OR NEW.context_state <> 'dismissed'
      OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.late IS DISTINCT FROM OLD.late THEN
      RAISE EXCEPTION 'chat reminder context can only be dismissed once';
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

-- The owner may lock any of their reminders, so cancel waits on an in-flight delivery and
-- then sees its result. It may only write the two owner moves.
CREATE POLICY chat_reminders_owner_cancel ON app.chat_reminders
  FOR UPDATE TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  )
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND (state = 'cancelled' OR (state = 'delivered' AND context_state = 'dismissed'))
  );

GRANT UPDATE ON app.chat_reminders TO jarvis_app_runtime;
