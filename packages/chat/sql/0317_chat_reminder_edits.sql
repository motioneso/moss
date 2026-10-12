-- #3135: owner edits pending reminder terms with a new job version.
CREATE OR REPLACE FUNCTION app.enforce_chat_reminder_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Terms edits preserve lifecycle/identity and invalidate every older queued version.
  IF OLD.state IN ('queued', 'paused') AND NEW.state = OLD.state
    AND NEW.version = OLD.version + 1 THEN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
      OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
      OR NEW.reserved_message_id IS DISTINCT FROM OLD.reserved_message_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.context_state IS DISTINCT FROM OLD.context_state
      OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.late IS DISTINCT FROM OLD.late
      OR NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
      RAISE EXCEPTION 'chat reminder edit cannot change identity or lifecycle';
    END IF;
    IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
      IF NEW.due_at <= now() OR NEW.due_at > now() + interval '30 days' THEN
        RAISE EXCEPTION 'chat reminder due time is out of range' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    IF NEW.timing = 'local_clock' THEN
      IF (NEW.local_due::timestamp AT TIME ZONE NEW.time_zone) IS DISTINCT FROM NEW.due_at
        OR to_char(NEW.due_at AT TIME ZONE NEW.time_zone, 'YYYY-MM-DD"T"HH24:MI') <> NEW.local_due THEN
        RAISE EXCEPTION 'chat reminder local time does not match its due time' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF (NEW.due_at IS DISTINCT FROM OLD.due_at
      OR NEW.delay_seconds IS DISTINCT FROM OLD.delay_seconds)
      AND abs(extract(epoch FROM NEW.due_at - now()) - NEW.delay_seconds) > 1 THEN
      RAISE EXCEPTION 'chat reminder delay does not match its due time' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
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

GRANT UPDATE (reminder_text, timing, delay_seconds, due_at, local_due, time_zone, deadline_at)
  ON app.chat_reminders TO jarvis_app_runtime;
