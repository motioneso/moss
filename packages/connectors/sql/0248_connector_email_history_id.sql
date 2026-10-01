-- #2804: remember the Gmail mailbox position at the start of the last clean backlog walk, so the
-- next walk asks Gmail only for mail that changed since. Additive only. The column sits on
-- app.connector_accounts, so it inherits that table's row-level security and grants unchanged.
ALTER TABLE app.connector_accounts
  ADD COLUMN IF NOT EXISTS email_history_id text;

COMMENT ON COLUMN app.connector_accounts.email_history_id IS
  'Gmail history position captured before the last backlog walk that finished with no email errors. Metadata only. NULL means the next backlog walk lists the whole window.';
