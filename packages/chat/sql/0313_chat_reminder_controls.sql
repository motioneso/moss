-- #3133: owner controls share delivery's row lock; resume uses a fresh job version.
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_state_check;
ALTER TABLE app.chat_reminders ADD CONSTRAINT chat_reminders_state_check
  CHECK (state IN ('queued', 'paused', 'delivered', 'failed', 'cancelled', 'expired'));

CREATE OR REPLACE FUNCTION app.chat_reminder_open_count_locked(target_owner uuid)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  open_count integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('chat_reminders:' || target_owner::text, 0));
  SELECT count(*) INTO open_count
  FROM app.chat_reminders
  WHERE owner_user_id = target_owner
    AND (state IN ('queued', 'paused') OR (state = 'delivered' AND context_state = 'pending'));
  RETURN open_count;
END;
$$;

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
    OR NEW.timing IS DISTINCT FROM OLD.timing
    OR NEW.local_due IS DISTINCT FROM OLD.local_due
    OR NEW.time_zone IS DISTINCT FROM OLD.time_zone
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat reminder identity cannot be changed';
  END IF;

  IF (OLD.state = 'queued' AND NEW.state = 'paused')
    OR (OLD.state = 'paused' AND NEW.state = 'queued') THEN
    IF NEW.version <> OLD.version + 1
      OR NEW.context_state IS DISTINCT FROM OLD.context_state
      OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.late IS DISTINCT FROM OLD.late
      OR NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
      RAISE EXCEPTION 'chat reminder control must change only state and version';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'chat reminder version changes only on pause or resume';
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
  IF NOT (OLD.state = 'queued' OR (OLD.state = 'paused' AND NEW.state = 'cancelled'))
    OR NEW.state NOT IN ('delivered', 'failed', 'cancelled', 'expired') THEN
    RAISE EXCEPTION 'chat reminder can only be delivered once';
  END IF;
  IF NEW.state = 'delivered' AND OLD.deadline_at IS NOT NULL AND now() > OLD.deadline_at THEN
    RAISE EXCEPTION 'chat reminder deadline has passed';
  END IF;
  IF NEW.state = 'expired' THEN
    IF OLD.deadline_at IS NULL OR now() <= OLD.deadline_at THEN
      RAISE EXCEPTION 'chat reminder can only expire after its deadline';
    END IF;
    NEW.expired_at := now();
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

DROP POLICY chat_reminders_owner_cancel ON app.chat_reminders;
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
    AND (state IN ('queued', 'paused', 'cancelled')
      OR (state = 'delivered' AND context_state = 'dismissed'))
  );
GRANT UPDATE (version) ON app.chat_reminders TO jarvis_app_runtime;

-- Deleting this row never deletes its referenced source or reserved result message.
CREATE POLICY chat_reminders_owner_delete ON app.chat_reminders
  FOR DELETE TO jarvis_app_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
GRANT DELETE ON app.chat_reminders TO jarvis_app_runtime;
