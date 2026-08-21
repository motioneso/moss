-- Draft status + owner for app.external_modules (#1753, Workshop 2). A draft is a module
-- being built by one admin-author, visible and runnable for that author alone until they
-- ship it. owner_user_id is NULL for every enabled/disabled row (those are instance-global,
-- not owned by one person) and NOT NULL for every draft row — enforced by CHECK, not trusted
-- to application code, per this repo's rule that ownership pairing is generated from the
-- declaration, not authored by hand.

ALTER TABLE app.external_modules
  ADD COLUMN owner_user_id uuid NULL REFERENCES app.users(id) ON DELETE CASCADE;

ALTER TABLE app.external_modules
  DROP CONSTRAINT external_modules_status_check;

ALTER TABLE app.external_modules
  ADD CONSTRAINT external_modules_status_check
  CHECK (status IN ('enabled', 'disabled', 'draft'));

ALTER TABLE app.external_modules
  ADD CONSTRAINT external_modules_draft_has_owner
  CHECK (
    (status = 'draft' AND owner_user_id IS NOT NULL)
    OR (status != 'draft' AND owner_user_id IS NULL)
  );
