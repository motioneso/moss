-- A timed-out request remains recoverable until its bound history write is acknowledged or
-- chat positively identifies a permanently ineligible origin. A skip is never a written outcome.
-- Legacy rows start unacknowledged; origin-less rows are never adopted into a current thread.
ALTER TABLE app.ai_assistant_action_requests
  ADD COLUMN outcome_recorded_at timestamptz,
  ADD COLUMN outcome_ignored_at timestamptz,
  ADD CONSTRAINT ai_assistant_action_outcome_recorded_terminal
    CHECK ((outcome_recorded_at IS NULL AND outcome_ignored_at IS NULL) OR status = 'timed_out'),
  ADD CONSTRAINT ai_assistant_action_outcome_disposition_exclusive
    CHECK (outcome_recorded_at IS NULL OR outcome_ignored_at IS NULL);

CREATE INDEX ai_assistant_action_requests_owner_pending_expiry_idx
ON app.ai_assistant_action_requests(owner_user_id, expires_at, id)
WHERE status = 'pending' AND expires_at IS NOT NULL;

CREATE INDEX ai_assistant_action_requests_unrecorded_timeout_idx
ON app.ai_assistant_action_requests(owner_user_id, id)
WHERE status = 'timed_out' AND outcome_recorded_at IS NULL AND outcome_ignored_at IS NULL
  AND chat_thread_id IS NOT NULL AND chat_session_id IS NOT NULL;
