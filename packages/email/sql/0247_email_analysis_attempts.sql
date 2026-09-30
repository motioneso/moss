-- #2804: count failed analysis attempts per message so a message that always
-- fails stops being re-sent every sync. Additive only. The worker runtime
-- grant on app.email_messages is table-level (0068), so no new grant is needed.
ALTER TABLE app.email_messages
  ADD COLUMN IF NOT EXISTS analysis_attempts integer NOT NULL DEFAULT 0;

ALTER TABLE app.email_messages
  DROP CONSTRAINT IF EXISTS email_messages_analysis_attempts_check,
  ADD CONSTRAINT email_messages_analysis_attempts_check
    CHECK (analysis_attempts >= 0);

COMMENT ON COLUMN app.email_messages.analysis_attempts IS
  'Failed analysis attempts for the stored Gmail revision. Reset to 0 when a new revision is saved; the sync leaves a revision alone once it reaches the cap.';
