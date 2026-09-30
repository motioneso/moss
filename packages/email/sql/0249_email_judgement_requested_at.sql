-- #2804: when the sync last asked for the thread judgement of this message, so an unchanged
-- hand-off is not re-requested on every run. Additive only. The worker runtime grant on
-- app.email_messages is table-level (0068), and the column inherits the table's row-level
-- security, so no policy or grant changes.
ALTER TABLE app.email_messages
  ADD COLUMN IF NOT EXISTS judgement_requested_at timestamptz;

COMMENT ON COLUMN app.email_messages.judgement_requested_at IS
  'When the sync last requested the thread judgement for the stored Gmail revision. Reset to NULL when a new revision is saved.';
