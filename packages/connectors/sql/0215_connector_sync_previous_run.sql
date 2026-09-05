ALTER TABLE app.connector_accounts
  ADD COLUMN IF NOT EXISTS last_sync_trigger text,
  ADD COLUMN IF NOT EXISTS previous_sync jsonb;

ALTER TABLE app.connector_accounts
  DROP CONSTRAINT IF EXISTS connector_accounts_last_sync_trigger_check,
  ADD CONSTRAINT connector_accounts_last_sync_trigger_check
    CHECK (last_sync_trigger IS NULL OR last_sync_trigger IN ('schedule', 'manual', 'assistant', 'on-connect')),
  DROP CONSTRAINT IF EXISTS connector_accounts_previous_sync_object_check,
  ADD CONSTRAINT connector_accounts_previous_sync_object_check
    CHECK (previous_sync IS NULL OR jsonb_typeof(previous_sync) = 'object');

COMMENT ON COLUMN app.connector_accounts.previous_sync IS
  'Snapshot of the prior finished run: {startedAt, finishedAt, status, errorCode, counts, trigger}. Counts only, never content.';

GRANT UPDATE (
  last_sync_trigger,
  previous_sync,
  updated_at
) ON app.connector_accounts TO jarvis_worker_runtime;
