-- #3138: exact requested Tasks checks share saved cadence and immutable occurrence history.
ALTER TABLE app.chat_scheduled_reads
  ADD COLUMN observation_key text CHECK (observation_key ~ '^[a-f0-9]{64}$'),
  ADD COLUMN failure_streak integer NOT NULL DEFAULT 0 CHECK (failure_streak >= 0);
-- Table-wide INSERT predates these columns, so fresh observation authority must be explicit.
DROP POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads;
CREATE POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND outcome IS NULL
    AND observation_key IS NULL AND failure_streak = 0 AND EXISTS (
      SELECT 1 FROM app.chat_reminders r WHERE r.id = reminder_id
        AND r.owner_user_id = app.current_actor_user_id() AND r.state = 'queued'
    ));
GRANT UPDATE(observation_key, failure_streak) ON app.chat_scheduled_reads TO jarvis_worker_runtime;
DROP TRIGGER chat_scheduled_reads_one_time ON app.chat_scheduled_reads;
DROP FUNCTION app.enforce_chat_scheduled_read_one_time();

-- Keep source attachment serialized with terms/control edits after lifting one-time-only policy.
CREATE FUNCTION app.lock_chat_scheduled_read_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM app.chat_reminders WHERE id = NEW.reminder_id FOR UPDATE;
  RETURN NEW;
END;
$$;
CREATE TRIGGER chat_scheduled_reads_schedule_lock BEFORE INSERT ON app.chat_scheduled_reads
  FOR EACH ROW EXECUTE FUNCTION app.lock_chat_scheduled_read_schedule();

ALTER TABLE app.chat_reminder_runs DROP CONSTRAINT chat_reminder_runs_outcome_check;
ALTER TABLE app.chat_reminder_runs DROP CONSTRAINT chat_reminder_runs_check;
ALTER TABLE app.chat_reminder_runs
  ADD CONSTRAINT chat_reminder_runs_outcome_check
    CHECK (outcome IN ('delivered','quiet','failed','refused','expired')),
  ADD CONSTRAINT chat_reminder_runs_message_shape CHECK (
    (outcome = 'delivered' AND message_id IS NOT NULL)
    OR (outcome IN ('quiet','expired') AND message_id IS NULL)
    OR outcome IN ('failed','refused')
  );
DROP POLICY chat_reminder_runs_insert ON app.chat_reminder_runs;
CREATE POLICY chat_reminder_runs_insert ON app.chat_reminder_runs
  FOR INSERT TO jarvis_worker_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND at = now() AND EXISTS (
    SELECT 1 FROM app.chat_reminders r
    WHERE r.id = reminder_id AND r.owner_user_id = app.current_actor_user_id()
      AND r.repeat_kind IS NOT NULL AND r.state = 'queued'
      AND r.version = chat_reminder_runs.version AND r.due_at = chat_reminder_runs.due_at
      AND r.due_at <= now()
      AND (
        (chat_reminder_runs.outcome = 'expired' AND message_id IS NULL AND now() > r.deadline_at)
        OR ((r.deadline_at IS NULL OR now() <= r.deadline_at) AND (
          (chat_reminder_runs.outcome = 'delivered' AND message_id = r.reserved_message_id)
          OR (chat_reminder_runs.outcome IN ('quiet','failed','refused') AND EXISTS (
            SELECT 1 FROM app.chat_scheduled_reads source
            WHERE source.reminder_id = r.id AND source.owner_user_id = r.owner_user_id
              AND ((chat_reminder_runs.outcome = 'quiet' AND source.outcome = 'success' AND source.observation_key IS NOT NULL)
                OR (chat_reminder_runs.outcome IN ('failed','refused') AND source.outcome = chat_reminder_runs.outcome
                  AND source.failure_streak > 0))
          ) AND (message_id IS NULL OR (message_id = r.reserved_message_id AND EXISTS (
            SELECT 1 FROM app.chat_scheduled_reads source WHERE source.reminder_id = r.id
              AND source.failure_streak = 3
          ))))
        ) AND (message_id IS NULL OR EXISTS (
          SELECT 1 FROM app.chat_messages m WHERE m.id = message_id
            AND m.thread_id = r.thread_id AND m.owner_user_id = r.owner_user_id
            AND m.role = 'assistant' AND m.status = 'stored'
        )))
      )
  ));

-- Same one-fresh-occurrence algorithm as reminders/repeating.ts, used only to validate
-- no-message completion when the final allowed read has already been recorded.
CREATE FUNCTION app.chat_reminder_next_read_due(
  kind text, seconds integer, saved_due timestamptz, local_due text, zone text
) RETURNS timestamptz LANGUAGE plpgsql STABLE AS $$
DECLARE
  step_days integer;
  day_count integer;
  next_local timestamp;
  candidate timestamptz;
BEGIN
  IF kind = 'interval' THEN
    RETURN saved_due + make_interval(secs => seconds *
      greatest(1, floor(extract(epoch FROM now() - saved_due) / seconds)::integer + 1));
  END IF;
  step_days := CASE WHEN kind = 'weekly' THEN 7 ELSE 1 END;
  day_count := greatest(0, (now() AT TIME ZONE zone)::date - local_due::date);
  next_local := local_due::timestamp + make_interval(days => (day_count / step_days) * step_days);
  candidate := app.chat_reminder_repeat_instant(to_char(next_local, 'YYYY-MM-DD"T"HH24:MI'), zone);
  IF candidate <= now() OR candidate <= saved_due THEN
    next_local := next_local + make_interval(days => step_days);
    candidate := app.chat_reminder_repeat_instant(to_char(next_local, 'YYYY-MM-DD"T"HH24:MI'), zone);
  END IF;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION app.enforce_chat_reminder_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
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
          AND ((run.message_id = OLD.reserved_message_id AND run.outcome = 'delivered')
            OR (run.outcome IN ('quiet','failed','refused') AND EXISTS (
              SELECT 1 FROM app.chat_scheduled_reads source WHERE source.reminder_id = OLD.id)))) THEN
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
  IF NEW.state = 'delivered' AND NOT (
    OLD.repeat_kind IS NOT NULL AND OLD.deadline_at IS NOT NULL
    AND app.chat_reminder_next_read_due(OLD.repeat_kind, OLD.repeat_seconds,
      OLD.due_at, OLD.local_due, OLD.time_zone) > OLD.deadline_at
    AND EXISTS (SELECT 1 FROM app.chat_scheduled_reads source WHERE source.reminder_id = OLD.id)
    AND EXISTS (SELECT 1 FROM app.chat_reminder_runs run
      WHERE run.reminder_id = OLD.id AND run.version = OLD.version
        AND run.outcome IN ('quiet','failed','refused') AND run.message_id IS NULL)
  ) AND NOT EXISTS (
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