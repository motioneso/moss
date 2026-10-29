-- #3530: measured admissions apply only to new occurrences after the conservative cutover.
ALTER TABLE app.chat_scheduled_reads
  ADD COLUMN attempt_message_id uuid,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 2),
  ADD COLUMN attempt_state text NOT NULL DEFAULT 'ready'
    CHECK (attempt_state IN ('ready','running','retry_pending','bookkeeping_pending','legacy_unknown','terminal')),
  ADD COLUMN attempt_token uuid,
  ADD COLUMN attempt_version integer CHECK (attempt_version > 0),
  ADD COLUMN attempt_lease_until timestamptz,
  ADD COLUMN recovery_job_id uuid,
  ADD COLUMN watchdog_token uuid,
  ADD COLUMN watchdog_generation integer NOT NULL DEFAULT 0 CHECK (watchdog_generation >= 0),
  ADD COLUMN watchdog_job_id uuid;

-- Only the migration owner may see all legacy identities for this transaction's backfill.
-- FORCE is restored before commit; runtime roles retain their owner policies throughout.
ALTER TABLE app.chat_scheduled_reads NO FORCE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminders NO FORCE ROW LEVEL SECURITY;
UPDATE app.chat_scheduled_reads s
SET attempt_message_id = r.reserved_message_id, attempt_state = 'legacy_unknown'
FROM app.chat_reminders r
WHERE r.id = s.reminder_id AND r.state IN ('queued', 'paused');
ALTER TABLE app.chat_scheduled_reads FORCE ROW LEVEL SECURITY;
ALTER TABLE app.chat_reminders FORCE ROW LEVEL SECURITY;

ALTER TABLE app.chat_scheduled_reads
  ADD CONSTRAINT chat_scheduled_read_watchdog_shape CHECK (
    (watchdog_job_id IS NULL AND watchdog_token IS NULL AND watchdog_generation = 0)
    OR (watchdog_job_id IS NOT NULL AND watchdog_generation > 0)
  ),
  ADD CONSTRAINT chat_scheduled_read_attempt_shape CHECK (
    (attempt_state = 'ready' AND attempt_message_id IS NULL AND attempt_count = 0
      AND attempt_token IS NULL AND attempt_version IS NULL AND attempt_lease_until IS NULL
      AND recovery_job_id IS NULL AND watchdog_job_id IS NULL)
    OR (attempt_message_id IS NOT NULL AND (
      (attempt_state = 'running' AND attempt_count IN (1,2)
        AND (attempt_count = 2 OR recovery_job_id IS NULL)
        AND attempt_token IS NOT NULL AND attempt_version IS NOT NULL
        AND attempt_lease_until IS NOT NULL AND watchdog_job_id IS NOT NULL
        AND watchdog_token IS NOT NULL AND watchdog_token = attempt_token)
      OR (attempt_token IS NULL AND attempt_version IS NULL AND attempt_lease_until IS NULL AND (
        (attempt_state = 'retry_pending' AND attempt_count = 1 AND recovery_job_id IS NOT NULL
          AND watchdog_job_id IS NOT NULL AND watchdog_token IS NOT NULL)
        OR (attempt_state = 'legacy_unknown' AND attempt_count = 0 AND recovery_job_id IS NULL
          AND watchdog_token IS NULL)
        OR (attempt_state IN ('bookkeeping_pending','terminal')
          AND (attempt_count = 0 OR (watchdog_job_id IS NOT NULL AND watchdog_token IS NOT NULL)))
      ))
    ))
  );

-- The pre-existing table-wide INSERT would otherwise grant every new authority column.
REVOKE INSERT ON app.chat_scheduled_reads FROM jarvis_app_runtime;
GRANT INSERT(reminder_id, owner_user_id, operation, item_id, outcome, observation_key, failure_streak)
  ON app.chat_scheduled_reads TO jarvis_app_runtime;
DROP POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads;
CREATE POLICY chat_scheduled_reads_insert ON app.chat_scheduled_reads
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND outcome IS NULL
    AND observation_key IS NULL AND failure_streak = 0
    AND attempt_state = 'ready' AND attempt_count = 0 AND attempt_message_id IS NULL
    AND attempt_token IS NULL AND attempt_version IS NULL AND attempt_lease_until IS NULL
    AND recovery_job_id IS NULL AND watchdog_token IS NULL AND watchdog_generation = 0
    AND watchdog_job_id IS NULL AND EXISTS (
      SELECT 1 FROM app.chat_reminders r WHERE r.id = reminder_id
        AND r.owner_user_id = app.current_actor_user_id() AND r.state = 'queued'
    ));
GRANT UPDATE(attempt_message_id, attempt_count, attempt_state, attempt_token,
  attempt_version, attempt_lease_until, recovery_job_id, watchdog_token,
  watchdog_generation, watchdog_job_id)
  ON app.chat_scheduled_reads TO jarvis_worker_runtime;
