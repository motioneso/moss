-- Android ring delivery reuses browser approval, with a distinct credential prefix.
-- Auth-runtime-only RLS/grants on the existing tables remain in force.
ALTER TABLE app.companion_pair_attempts DROP CONSTRAINT companion_pair_attempts_platform_check;
ALTER TABLE app.companion_pair_attempts ADD CONSTRAINT companion_pair_attempts_platform_check
  CHECK (platform IN ('macos', 'android'));
ALTER TABLE app.companion_devices DROP CONSTRAINT companion_devices_platform_check;
ALTER TABLE app.companion_devices ADD CONSTRAINT companion_devices_platform_check
  CHECK (platform IN ('macos', 'android'));
