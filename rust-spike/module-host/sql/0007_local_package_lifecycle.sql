-- Upgrades may replace package bytes, never ownership or installation identity.
-- The existing forced owner RLS applies to both UPDATE visibility and checks.
GRANT UPDATE (digest) ON moss_modules.local_packages TO jarvis_app_runtime;
