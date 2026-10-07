-- Only an explicit acceptance of the current installation can establish descriptor ownership.
-- Do not backfill from enabled_by: it can name an earlier installer after an upgrade.
ALTER TABLE app.external_modules
  ADD COLUMN IF NOT EXISTS descriptor_approved_by uuid
    REFERENCES app.users (id) ON DELETE SET NULL;
