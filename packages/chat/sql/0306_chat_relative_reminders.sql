-- #3309: one relative reminder saved from a raw Main chat request and delivered once,
-- as a reserved assistant message, into the owner's Main chat history.
CREATE TABLE app.chat_reminders (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES app.chat_threads (id) ON DELETE CASCADE,
  source_message_id uuid NOT NULL UNIQUE REFERENCES app.chat_messages (id) ON DELETE CASCADE,
  reserved_message_id uuid NOT NULL UNIQUE,
  reminder_text text NOT NULL CHECK (length(reminder_text) BETWEEN 1 AND 500
    AND length(btrim(reminder_text)) > 0),
  delay_seconds integer NOT NULL CHECK (delay_seconds BETWEEN 1 AND 2592000),
  due_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'delivered', 'failed')),
  context_state text NOT NULL DEFAULT 'pending' CHECK (context_state IN ('pending')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  delivered_at timestamptz,
  late boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (reserved_message_id <> source_message_id),
  CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  CHECK ((state = 'delivered') = (late IS NOT NULL))
);

CREATE INDEX chat_reminders_owner_state_idx
  ON app.chat_reminders (owner_user_id, state, context_state);

ALTER TABLE app.chat_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminders FORCE ROW LEVEL SECURITY;

-- Serializes reminder creation per owner and counts the reminders that hold a slot.
-- Delivered reminders keep their slot while their context is still pending. Failed
-- reminders never delivered, so they hold no slot.
CREATE FUNCTION app.chat_reminder_open_count_locked(target_owner uuid)
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
    AND (state = 'queued' OR (state = 'delivered' AND context_state = 'pending'));
  RETURN open_count;
END;
$$;

-- The database clock sets the due time, and the per-owner cap is enforced here so no
-- caller can skip it.
CREATE FUNCTION app.enforce_chat_reminder_insert()
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
  NEW.created_at := now();
  NEW.due_at := now() + make_interval(secs => NEW.delay_seconds);
  RETURN NEW;
END;
$$;

CREATE TRIGGER chat_reminders_enforce_insert
BEFORE INSERT ON app.chat_reminders
FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_reminder_insert();

-- The only update ends a queued reminder once, as delivered or failed, with nothing else
-- changing. Delivery needs its reserved message.
CREATE FUNCTION app.enforce_chat_reminder_update()
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
    OR NEW.context_state IS DISTINCT FROM OLD.context_state
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'chat reminder identity cannot be changed';
  END IF;
  IF OLD.state <> 'queued' OR NEW.state NOT IN ('delivered', 'failed') THEN
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

CREATE TRIGGER chat_reminders_enforce_update
BEFORE UPDATE ON app.chat_reminders
FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_reminder_update();

-- Thread sharing never exposes reminders. Creation is limited to the actor's own Main chat.
CREATE POLICY chat_reminders_select ON app.chat_reminders
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id AND thread.owner_user_id = app.current_actor_user_id()
    )
  );
CREATE POLICY chat_reminders_insert ON app.chat_reminders
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (
    owner_user_id = app.current_actor_user_id()
    AND EXISTS (
      SELECT 1 FROM app.chat_threads thread
      WHERE thread.id = thread_id
        AND thread.owner_user_id = app.current_actor_user_id()
        AND thread.is_main
    )
    AND EXISTS (
      SELECT 1 FROM app.chat_messages message
      WHERE message.id = source_message_id
        AND message.thread_id = chat_reminders.thread_id
        AND message.owner_user_id = app.current_actor_user_id()
        AND message.role = 'user'
    )
  );
CREATE POLICY chat_reminders_deliver ON app.chat_reminders
  FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id() AND state = 'queued')
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND state IN ('delivered', 'failed'));

GRANT SELECT, INSERT ON app.chat_reminders TO jarvis_app_runtime;
GRANT SELECT, UPDATE ON app.chat_reminders TO jarvis_worker_runtime;

-- The worker may insert exactly one kind of chat row: the reserved assistant message of
-- a queued reminder, into the owner's current Main chat.
GRANT INSERT ON app.chat_messages TO jarvis_worker_runtime;

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
        AND thread.owner_user_id = app.current_actor_user_id()
        AND thread.is_main
    )
  );
