-- #3136: saved recurrence and one immutable result identity per occurrence.
ALTER TABLE app.chat_reminders
  ADD COLUMN repeat_kind text CHECK (repeat_kind IN ('daily', 'weekly', 'interval')),
  ADD COLUMN repeat_seconds integer,
  ADD CONSTRAINT chat_reminders_repeat_shape CHECK (
    (repeat_kind IS NULL AND repeat_seconds IS NULL)
    OR (repeat_kind IS NOT NULL AND repeat_kind IN ('daily', 'weekly')
      AND timing = 'local_clock' AND repeat_seconds IS NULL)
    OR (repeat_kind IS NOT NULL AND repeat_kind = 'interval' AND timing = 'relative'
      AND repeat_seconds IS NOT NULL AND repeat_seconds BETWEEN 60 AND 86399)
  );
ALTER TABLE app.chat_reminders DROP CONSTRAINT chat_reminders_deadline_after_due;
ALTER TABLE app.chat_reminders ADD CONSTRAINT chat_reminders_deadline_after_due CHECK (
  deadline_at IS NULL OR (repeat_kind IS NOT NULL AND deadline_at >= due_at)
    OR (repeat_kind IS NULL AND deadline_at > due_at
      AND timing = 'local_clock' AND deadline_at <= due_at + interval '12 hours')
);

CREATE TABLE app.chat_reminder_runs (
  id uuid PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES app.chat_reminders(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  due_at timestamptz NOT NULL,
  at timestamptz NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'expired')),
  message_id uuid UNIQUE REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  late boolean NOT NULL,
  context_state text NOT NULL DEFAULT 'pending' CHECK (context_state IN ('pending','acknowledged','dismissed')),
  UNIQUE (reminder_id, version),
  CHECK ((outcome = 'delivered') = (message_id IS NOT NULL))
);
CREATE INDEX chat_reminder_runs_history_idx ON app.chat_reminder_runs(reminder_id, at DESC);
ALTER TABLE app.chat_reminder_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminder_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY chat_reminder_runs_select ON app.chat_reminder_runs
  FOR SELECT TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id() AND EXISTS (
    SELECT 1 FROM app.chat_reminders r WHERE r.id = reminder_id AND r.owner_user_id = app.current_actor_user_id()
  ));
CREATE POLICY chat_reminder_runs_insert ON app.chat_reminder_runs
  FOR INSERT TO jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND at = now() AND EXISTS (
    SELECT 1 FROM app.chat_reminders r
    WHERE r.id = reminder_id AND r.owner_user_id = app.current_actor_user_id()
      AND r.repeat_kind IS NOT NULL AND r.state = 'queued'
      AND r.version = chat_reminder_runs.version AND r.due_at = chat_reminder_runs.due_at
      AND r.due_at <= now()
      AND ((outcome = 'delivered' AND message_id = r.reserved_message_id
        AND (r.deadline_at IS NULL OR now() <= r.deadline_at)
        AND EXISTS (SELECT 1 FROM app.chat_messages m WHERE m.id = message_id
          AND m.thread_id = r.thread_id AND m.owner_user_id = r.owner_user_id
          AND m.role = 'assistant' AND m.status = 'stored'))
        OR (outcome = 'expired' AND message_id IS NULL AND now() > r.deadline_at))
  ));
CREATE POLICY chat_reminder_runs_acknowledge ON app.chat_reminder_runs
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT ON app.chat_reminder_runs TO jarvis_app_runtime, jarvis_worker_runtime;
GRANT INSERT ON app.chat_reminder_runs TO jarvis_worker_runtime;
GRANT UPDATE (context_state) ON app.chat_reminder_runs TO jarvis_app_runtime;
CREATE FUNCTION app.enforce_chat_reminder_run_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - 'context_state') IS DISTINCT FROM (to_jsonb(OLD) - 'context_state')
    OR OLD.context_state <> 'pending' OR NEW.context_state NOT IN ('acknowledged','dismissed') THEN
    RAISE EXCEPTION 'chat reminder run is immutable except pending context';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_reminder_runs_enforce_update BEFORE UPDATE ON app.chat_reminder_runs
  FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_reminder_run_update();

-- Same saved-schedule DST policy as the SDK: earlier fold, gap shifted forward.
CREATE FUNCTION app.chat_reminder_repeat_instant(local_value text, zone text)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  WITH wall AS (SELECT local_value::timestamp AS local),
  samples AS (SELECT (local AT TIME ZONE 'UTC') + delta AS instant, local FROM wall,
    (VALUES (interval '-1 day'), (interval '1 day')) AS offsets(delta)),
  candidates AS (SELECT (local - ((instant AT TIME ZONE zone) - (instant AT TIME ZONE 'UTC')))
    AT TIME ZONE 'UTC' AS instant, local FROM samples)
  SELECT coalesce(min(instant) FILTER (WHERE instant AT TIME ZONE zone = local),
    (local_value::timestamp AT TIME ZONE zone)) FROM candidates
$$;

CREATE OR REPLACE FUNCTION app.enforce_chat_reminder_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.repeat_kind IS NOT NULL AND EXISTS (
    SELECT 1 FROM app.chat_scheduled_reads WHERE reminder_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'task checks must run once';
  END IF;
  -- Advancing is a worker-only effect, validated against the just-persisted occurrence.
  IF OLD.state = 'queued' AND NEW.state = 'queued' AND OLD.repeat_kind IS NOT NULL
    AND NEW.reserved_message_id IS DISTINCT FROM OLD.reserved_message_id THEN
    IF current_user <> 'jarvis_worker_runtime'
      OR NEW.version <> OLD.version + 1 OR NEW.due_at <= now()
      OR NEW.due_at <= OLD.due_at OR NEW.due_at > now() + interval '30 days'
      OR (to_jsonb(NEW) - ARRAY['version','due_at','local_due','reserved_message_id'])
        IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['version','due_at','local_due','reserved_message_id'])
      OR NOT EXISTS (SELECT 1 FROM app.chat_reminder_runs run
        WHERE run.reminder_id = OLD.id AND run.version = OLD.version
          AND run.message_id = OLD.reserved_message_id AND run.outcome = 'delivered') THEN
      RAISE EXCEPTION 'chat reminder advancement needs its persisted run';
    END IF;
    IF NEW.timing = 'local_clock' AND app.chat_reminder_repeat_instant(NEW.local_due, NEW.time_zone) IS DISTINCT FROM NEW.due_at THEN
      RAISE EXCEPTION 'chat reminder next local time does not match';
    END IF;
    IF NEW.timing = 'local_clock' THEN
      IF right(NEW.local_due, 5) <> right(OLD.local_due, 5)
        OR (NEW.local_due::date - OLD.local_due::date) <= 0
        OR (OLD.repeat_kind = 'weekly' AND (NEW.local_due::date - OLD.local_due::date) % 7 <> 0)
        OR app.chat_reminder_repeat_instant(to_char(NEW.local_due::timestamp -
          CASE WHEN OLD.repeat_kind = 'weekly' THEN interval '7 days' ELSE interval '1 day' END,
          'YYYY-MM-DD"T"HH24:MI'), NEW.time_zone) > now() THEN
        RAISE EXCEPTION 'chat reminder advancement must preserve local cadence';
      END IF;
    ELSE
      IF abs(extract(epoch FROM NEW.due_at - OLD.due_at) /
        OLD.repeat_seconds - round(extract(epoch FROM NEW.due_at - OLD.due_at) / OLD.repeat_seconds)) > 0.0001
        OR NEW.due_at - make_interval(secs => OLD.repeat_seconds) > now() THEN
        RAISE EXCEPTION 'chat reminder advancement must preserve interval cadence';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  -- Terms edits preserve lifecycle/identity and invalidate every older queued version.
  IF OLD.state IN ('queued', 'paused') AND NEW.state = OLD.state
    AND NEW.version = OLD.version + 1 THEN
    IF current_user <> 'jarvis_app_runtime' THEN
      RAISE EXCEPTION 'chat reminder terms edits require owner runtime';
    END IF;
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
    IF NEW.timing = 'local_clock' AND (NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.local_due IS DISTINCT FROM OLD.local_due OR NEW.time_zone IS DISTINCT FROM OLD.time_zone) THEN
      IF (NEW.local_due::timestamp AT TIME ZONE NEW.time_zone) IS DISTINCT FROM NEW.due_at
        OR to_char(NEW.due_at AT TIME ZONE NEW.time_zone, 'YYYY-MM-DD"T"HH24:MI') <> NEW.local_due THEN
        RAISE EXCEPTION 'chat reminder local time does not match its due time' USING ERRCODE = 'check_violation';
      END IF;
    ELSIF NEW.timing = 'relative' AND (NEW.due_at IS DISTINCT FROM OLD.due_at
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
    OR NEW.repeat_kind IS DISTINCT FROM OLD.repeat_kind
    OR NEW.repeat_seconds IS DISTINCT FROM OLD.repeat_seconds
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


GRANT UPDATE (repeat_kind, repeat_seconds) ON app.chat_reminders TO jarvis_app_runtime;
DROP POLICY chat_reminders_deliver ON app.chat_reminders;
CREATE POLICY chat_reminders_deliver ON app.chat_reminders
  FOR UPDATE TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id() AND state = 'queued')
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND state IN ('queued','delivered','failed','expired'));

-- Lock the responsibility so inserting an extension and editing its repeat cannot race.
CREATE FUNCTION app.enforce_chat_scheduled_read_one_time()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE saved_repeat text;
BEGIN
  SELECT repeat_kind INTO saved_repeat FROM app.chat_reminders
    WHERE id = NEW.reminder_id FOR UPDATE;
  IF saved_repeat IS NOT NULL THEN
    RAISE EXCEPTION 'task checks must run once';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_scheduled_reads_one_time BEFORE INSERT ON app.chat_scheduled_reads
  FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_scheduled_read_one_time();
