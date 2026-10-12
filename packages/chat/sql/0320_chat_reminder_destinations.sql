-- #3148: the delivery identity is independent of the owner-authored creation turn.
-- Preserve the owner foreign key: account deletion still removes every reminder.
ALTER TABLE app.chat_reminders ADD COLUMN destination_title text;
ALTER TABLE app.chat_reminders ADD CONSTRAINT chat_reminders_destination_title_shape
  CHECK (destination_title IS NULL OR length(btrim(destination_title)) > 0);
-- Retain failed task status when either the destination or source chat is deleted.
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_thread_id_fkey;
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_source_message_id_fkey;
GRANT UPDATE (thread_id, destination_title) ON app.chat_reminders TO jarvis_app_runtime;
-- SELECT FOR SHARE needs an UPDATE privilege; no worker UPDATE policy is added.
GRANT UPDATE (id) ON app.chat_threads TO jarvis_worker_runtime;

CREATE FUNCTION app.check_chat_reminder_destination(target_owner uuid, target_thread uuid, target_title text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  PERFORM id FROM app.chat_threads
  WHERE id = target_thread AND owner_user_id = target_owner
    AND surface = 'drawer' AND NOT incognito
    AND ((target_title IS NULL AND is_main)
      OR (target_title IS NOT NULL AND NOT is_main AND title = target_title))
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'chat reminder destination is unavailable' USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

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
      OR NEW.source_message_id IS DISTINCT FROM OLD.source_message_id
      OR NEW.reserved_message_id IS DISTINCT FROM OLD.reserved_message_id
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.context_state IS DISTINCT FROM OLD.context_state
      OR NEW.delivered_at IS DISTINCT FROM OLD.delivered_at
      OR NEW.late IS DISTINCT FROM OLD.late
      OR NEW.expired_at IS DISTINCT FROM OLD.expired_at THEN
      RAISE EXCEPTION 'chat reminder edit cannot change identity or lifecycle';
    END IF;
    IF NEW.thread_id IS DISTINCT FROM OLD.thread_id
      OR NEW.destination_title IS DISTINCT FROM OLD.destination_title THEN
      PERFORM app.check_chat_reminder_destination(NEW.owner_user_id, NEW.thread_id, NEW.destination_title);
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
    OR NEW.destination_title IS DISTINCT FROM OLD.destination_title
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


DROP POLICY chat_reminders_select ON app.chat_reminders;
CREATE POLICY chat_reminders_select ON app.chat_reminders
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY chat_reminders_insert ON app.chat_reminders;
CREATE POLICY chat_reminders_insert ON app.chat_reminders
  FOR INSERT TO jarvis_app_runtime WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (SELECT 1 FROM app.chat_threads target
      WHERE target.id = thread_id AND target.owner_user_id = app.current_actor_user_id()
        AND target.surface = 'drawer' AND NOT target.incognito
        AND ((destination_title IS NULL AND target.is_main)
          OR (destination_title IS NOT NULL AND NOT target.is_main AND target.title = destination_title)))
    AND EXISTS (SELECT 1 FROM app.chat_messages source
      JOIN app.chat_threads source_thread ON source_thread.id = source.thread_id
      WHERE source.id = source_message_id AND source.role = 'user'
        AND source.owner_user_id = app.current_actor_user_id()
        AND source_thread.owner_user_id = app.current_actor_user_id()
        AND source_thread.surface = 'drawer' AND NOT source_thread.incognito)
  );

DROP POLICY chat_reminders_owner_cancel ON app.chat_reminders;
CREATE POLICY chat_reminders_owner_cancel ON app.chat_reminders
  FOR UPDATE TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id()
    AND (state IN ('queued', 'paused', 'cancelled')
      OR (state = 'delivered' AND context_state = 'dismissed')));
DROP POLICY chat_reminders_owner_delete ON app.chat_reminders;
CREATE POLICY chat_reminders_owner_delete ON app.chat_reminders
  FOR DELETE TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id());

DROP POLICY chat_messages_insert_reminder ON app.chat_messages;
CREATE POLICY chat_messages_insert_reminder ON app.chat_messages
  FOR INSERT TO jarvis_worker_runtime WITH CHECK (
    owner_user_id = app.current_actor_user_id() AND role = 'assistant' AND status = 'stored'
    AND EXISTS (SELECT 1 FROM app.chat_reminders reminder
      JOIN app.chat_threads target ON target.id = reminder.thread_id
      WHERE reminder.reserved_message_id = chat_messages.id
        AND reminder.thread_id = chat_messages.thread_id
        AND reminder.owner_user_id = app.current_actor_user_id()
        AND reminder.state = 'queued'
        AND (reminder.deadline_at IS NULL OR now() <= reminder.deadline_at)
        AND target.owner_user_id = app.current_actor_user_id()
        AND target.surface = 'drawer' AND NOT target.incognito
        AND (reminder.destination_title IS NOT NULL OR target.is_main))
  );

-- A reply acknowledges only reminders delivered in that exact owned drawer conversation.
DROP POLICY chat_reminders_acknowledge ON app.chat_reminders;
CREATE POLICY chat_reminders_acknowledge ON app.chat_reminders
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id() AND state = 'delivered' AND context_state = 'pending')
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND state = 'delivered'
    AND context_state = 'acknowledged'
    AND EXISTS (SELECT 1 FROM app.chat_threads target WHERE target.id = thread_id
      AND target.owner_user_id = app.current_actor_user_id() AND target.surface = 'drawer' AND NOT target.incognito));
