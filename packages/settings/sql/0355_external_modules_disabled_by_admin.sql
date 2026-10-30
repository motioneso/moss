-- #3560: remember that an ADMIN switched a module off, so the boot reconcile's acceptance of a
-- staged download refreshes the baseline hashes without switching the module back on. Status
-- 'disabled' alone cannot say this: a module is also born disabled while its first package is
-- staged, and drift or a failed database install disable it without any admin intent. Those two
-- cases may be re-enabled by acceptance; an admin's switch may not.
ALTER TABLE app.external_modules
  ADD COLUMN IF NOT EXISTS disabled_by_admin boolean NOT NULL DEFAULT false;

-- Existing rows carry the intent in their reason text only (the admin toggle's reason string).
-- Backfill it so an instance that already has a module switched off keeps it off after upgrading.
-- 'removed by admin' is NOT admin-off intent: a later download of a removed module is an explicit
-- install, so it stays eligible for acceptance to bring it back on.
UPDATE app.external_modules
   SET disabled_by_admin = true
 WHERE status = 'disabled'
   AND disabled_reason = 'disabled by admin';
