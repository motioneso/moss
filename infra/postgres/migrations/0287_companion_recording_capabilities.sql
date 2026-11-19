-- Independent, explicitly approved recording proof. Existing paired devices receive no grant.
-- RLS classification: owner/device data behind auth-runtime-only access, like companion_devices.
-- Plaintext proofs never persist; ordinary app/worker roles have no access to these tables.
ALTER TABLE app.companion_devices ADD CONSTRAINT companion_devices_id_owner_key UNIQUE (id, user_id);
ALTER TABLE app.companion_pair_attempts
  ADD COLUMN recording_proof_hash text CHECK (recording_proof_hash ~ '^[a-f0-9]{64}$'),
  ADD COLUMN recording_policy_version integer CHECK (recording_policy_version = 1),
  ADD COLUMN recording_consent_version integer CHECK (recording_consent_version = 1),
  ADD CONSTRAINT companion_pair_recording_request_check CHECK (
    (recording_proof_hash IS NULL AND recording_policy_version IS NULL AND recording_consent_version IS NULL)
    OR (recording_proof_hash IS NOT NULL AND recording_policy_version = 1)
  );

CREATE TABLE app.companion_recording_capabilities (
  device_id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[a-f0-9]{64}$'),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  revision integer NOT NULL CHECK (revision > 0),
  approved_at timestamptz NOT NULL,
  revoked_at timestamptz,
  FOREIGN KEY (device_id, owner_user_id) REFERENCES app.companion_devices(id, user_id) ON DELETE CASCADE
);

CREATE TABLE app.companion_recording_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  device_id uuid NOT NULL,
  request_key uuid NOT NULL,
  proof_hash text NOT NULL CHECK (proof_hash ~ '^[a-f0-9]{64}$'),
  policy_version integer NOT NULL CHECK (policy_version = 1),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
  approved_revision integer,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  FOREIGN KEY (device_id, owner_user_id) REFERENCES app.companion_devices(id, user_id) ON DELETE CASCADE,
  UNIQUE (device_id, request_key),
  CHECK ((status = 'approved' AND approved_revision > 0) OR (status <> 'approved' AND approved_revision IS NULL))
);
CREATE INDEX companion_recording_attempts_owner_idx ON app.companion_recording_attempts(owner_user_id, device_id, expires_at);

ALTER TABLE app.companion_recording_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_recording_capabilities FORCE ROW LEVEL SECURITY;
ALTER TABLE app.companion_recording_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.companion_recording_attempts FORCE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.companion_recording_capabilities,app.companion_recording_attempts TO jarvis_auth_runtime;
CREATE POLICY companion_recording_capabilities_auth_runtime ON app.companion_recording_capabilities
  FOR ALL TO jarvis_auth_runtime USING (true) WITH CHECK (true);
CREATE POLICY companion_recording_attempts_auth_runtime ON app.companion_recording_attempts
  FOR ALL TO jarvis_auth_runtime USING (true) WITH CHECK (true);
