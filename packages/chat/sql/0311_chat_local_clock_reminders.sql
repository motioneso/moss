-- #3150: a reminder can be set for a local clock time in the owner's time zone, with an optional
-- deadline. A reminder still queued after its deadline is expired by the worker and never posts.
ALTER TABLE app.chat_reminders
  ADD COLUMN timing text NOT NULL DEFAULT 'relative'
    CHECK (timing IN ('relative', 'local_clock')),
  ADD COLUMN local_due text
    CHECK (local_due ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  ADD COLUMN time_zone text
    CHECK (length(time_zone) BETWEEN 1 AND 100),
  ADD COLUMN deadline_at timestamptz,
  ADD COLUMN expired_at timestamptz;

ALTER TABLE app.chat_reminders ALTER COLUMN delay_seconds DROP NOT NULL;

ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_timing_shape CHECK (
    (timing = 'relative'
      AND delay_seconds IS NOT NULL AND local_due IS NULL AND time_zone IS NULL)
    OR (timing = 'local_clock'
      AND delay_seconds IS NULL AND local_due IS NOT NULL AND time_zone IS NOT NULL)
  ),
  ADD CONSTRAINT chat_reminders_deadline_after_due CHECK (
    deadline_at IS NULL
    OR (timing = 'local_clock'
      AND deadline_at > due_at AND deadline_at <= due_at + interval '12 hours')
  );

ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_state_check;
ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_state_check
  CHECK (state IN ('queued', 'delivered', 'failed', 'cancelled', 'expired'));

ALTER TABLE app.chat_reminders
  ADD CONSTRAINT chat_reminders_expired_shape CHECK (
    (state = 'expired') = (expired_at IS NOT NULL)
    AND (state <> 'expired' OR expired_at > deadline_at)
  );

-- A relative reminder's due time comes from the database clock. A local-clock reminder brings its
-- due time, and its wall clock and instant must match in both directions, which refuses a time the
-- clocks skip. A time the clocks show twice passes here; the code refuses it before saving.
CREATE OR REPLACE FUNCTION app.enforce_chat_reminder_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF app.chat_reminder_open_count_locked(NEW.owner_user_id) >= 20 THEN
    RAISE EXCEPTION 'chat_reminder_capacity_reached' USING ERRCODE = 'check_violation';
  END IF;
  NEW.state := 'queued';
  NEW.context_state := 'pending';
  NEW.version := 1;
  NEW.delivered_at := NULL;
  NEW.late := NULL;
  NEW.expired_at := NULL;
  NEW.created_at := now();
  IF NEW.timing = 'local_clock' THEN
    IF (NEW.local_due::timestamp AT TIME ZONE NEW.time_zone) IS DISTINCT FROM NEW.due_at THEN
      RAISE EXCEPTION 'chat reminder local time does not match its due time'
        USING ERRCODE = 'check_violation';
    END IF;
    IF to_char(NEW.due_at AT TIME ZONE NEW.time_zone, 'YYYY-MM-DD"T"HH24:MI') <> NEW.local_due THEN
      RAISE EXCEPTION 'chat reminder local time is skipped by the clocks'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.due_at <= now() OR NEW.due_at > now() + interval '30 days' THEN
      RAISE EXCEPTION 'chat reminder due time is out of range' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    NEW.due_at := now() + make_interval(secs => NEW.delay_seconds);
  END IF;
  RETURN NEW;
END;
$$;

-- Allowed moves, with every other column fixed:
--   queued -> delivered | failed      (worker; delivered needs its reserved message and an open deadline)
--   queued -> expired                 (worker; only once the deadline has passed)
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
    OR NEW.timing IS DISTINCT FROM OLD.timing
    OR NEW.local_due IS DISTINCT FROM OLD.local_due
    OR NEW.time_zone IS DISTINCT FROM OLD.time_zone
    OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at
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
  IF OLD.state <> 'queued'
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

DROP POLICY chat_reminders_deliver ON app.chat_reminders;
CREATE POLICY chat_reminders_deliver ON app.chat_reminders
  FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id() AND state = 'queued')
  WITH CHECK (
    owner_user_id = app.current_actor_user_id() AND state IN ('delivered', 'failed', 'expired')
  );

-- The reserved message can no longer be written once the reminder's deadline has passed.
DROP POLICY chat_messages_insert_reminder ON app.chat_messages;
CREATE POLICY chat_messages_insert_reminder ON app.chat_messages
  FOR INSERT TO jarvis_worker_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND role = 'assistant'
    AND status = 'stored'
    AND EXISTS (
      SELECT 1
      FROM app.chat_reminders reminder
      JOIN app.chat_threads thread ON thread.id = reminder.thread_id
      WHERE reminder.reserved_message_id = chat_messages.id
        AND reminder.thread_id = chat_messages.thread_id
        AND reminder.owner_user_id = app.current_actor_user_id()
        AND reminder.state = 'queued'
        AND (reminder.deadline_at IS NULL OR now() <= reminder.deadline_at)
        AND thread.owner_user_id = app.current_actor_user_id()
        AND thread.is_main
    )
  );
