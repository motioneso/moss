-- Trail Marker Mac companion: browser-approved pairing attempts and the restricted
-- companion credential they mint (#2560).
--
-- Both tables sit behind the auth boundary, like app.auth_sessions (0046). Only
-- jarvis_auth_runtime holds a grant: app and worker runtime roles get none, so no
-- module and no background job can read a credential hash or a pairing verifier.
-- RLS classification: owner-only, auth-runtime-only.
--
-- Neither table stores a reusable secret. The pairing verifier, the browser approval
-- code and the companion credential are all kept as sha256 digests; the raw values
-- exist only on the Mac and in the one response that issues them.

CREATE TABLE app.companion_pair_attempts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_code_hash text NOT NULL UNIQUE,
  verifier_hash      text NOT NULL,
  device_name        text NOT NULL CHECK (char_length(device_name) BETWEEN 1 AND 64),
  platform           text NOT NULL CHECK (platform = 'macos'),
  app_version        text NOT NULL CHECK (char_length(app_version) <= 32),
  os_version         text NOT NULL CHECK (char_length(os_version) <= 32),
  status             text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'approved', 'denied', 'redeemed')),
  user_id            uuid REFERENCES app.users (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,

  -- An attempt has no account until the browser decides it. Once decided, the
  -- approving account is bound here and can never be absent.
  CONSTRAINT companion_pair_attempts_decided_has_user
    CHECK (status = 'pending' OR user_id IS NOT NULL)
);

CREATE INDEX companion_pair_attempts_expires_at_idx
  ON app.companion_pair_attempts (expires_at);

CREATE TABLE app.companion_devices (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  credential_hash     text NOT NULL UNIQUE,
  display_name        text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 64),
  platform            text NOT NULL CHECK (platform = 'macos'),
  app_version         text NOT NULL CHECK (char_length(app_version) <= 32),
  os_version          text NOT NULL CHECK (char_length(os_version) <= 32),
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_contact_at     timestamptz,

  -- Sliding inactivity expiry, extended on every authenticated companion call,
  -- never past the absolute cap. Relinking through the browser issues a new row.
  expires_at          timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL
);

CREATE INDEX companion_devices_user_id_idx ON app.companion_devices (user_id);

ALTER TABLE app.companion_pair_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_pair_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE app.companion_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_devices FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON app.companion_pair_attempts TO jarvis_auth_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON app.companion_devices TO jarvis_auth_runtime;

CREATE POLICY companion_pair_attempts_auth_runtime
  ON app.companion_pair_attempts
  FOR ALL
  TO jarvis_auth_runtime
  USING (true)
  WITH CHECK (true);

CREATE POLICY companion_devices_auth_runtime
  ON app.companion_devices
  FOR ALL
  TO jarvis_auth_runtime
  USING (true)
  WITH CHECK (true);
