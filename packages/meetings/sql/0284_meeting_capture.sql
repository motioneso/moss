-- Proposed IDs on pending links are untrusted: no meeting FK or content read before approval.
CREATE TABLE app.meeting_capture_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  meeting_id UUID NOT NULL,
  device_id UUID NOT NULL,
  device_name TEXT NOT NULL CHECK (octet_length(device_name) BETWEEN 1 AND 256),
  verifier_hash TEXT NOT NULL CHECK (verifier_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved')),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX meeting_capture_links_owner ON app.meeting_capture_links (owner_user_id,meeting_id);
ALTER TABLE app.meeting_capture_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_links FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_links_owner ON app.meeting_capture_links FOR ALL TO jarvis_app_runtime USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_capture_links TO jarvis_app_runtime;
GRANT UPDATE (status) ON app.meeting_capture_links TO jarvis_app_runtime;

-- Separate meeting/device grants, control receipts and metadata-only audio receipts.
CREATE TABLE app.meeting_capture_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  device_id UUID NOT NULL,
  device_name TEXT NOT NULL CHECK (octet_length(device_name) BETWEEN 1 AND 256),
  verifier_hash TEXT NOT NULL CHECK (verifier_hash ~ '^[a-f0-9]{64}$'),
  credential_hash TEXT CHECK (credential_hash ~ '^[a-f0-9]{64}$'),
  session_id UUID,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','active','revoked')),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ(3) NOT NULL,
  state_json TEXT CHECK (octet_length(state_json) <= 524288),
  UNIQUE (id,owner_user_id),
  FOREIGN KEY (meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE
);
CREATE INDEX meeting_capture_grants_meeting ON app.meeting_capture_grants (meeting_id,created_at);
CREATE UNIQUE INDEX meeting_capture_one_active ON app.meeting_capture_grants (meeting_id) WHERE status='active';
ALTER TABLE app.meeting_capture_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_grants_owner ON app.meeting_capture_grants FOR ALL TO jarvis_app_runtime USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT ON app.meeting_capture_grants TO jarvis_app_runtime;
GRANT UPDATE (credential_hash,session_id,status,expires_at,state_json) ON app.meeting_capture_grants TO jarvis_app_runtime;

CREATE TABLE app.meeting_capture_receipts (
  grant_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('control','audio')),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[a-f0-9]{64}$'),
  metadata_json TEXT NOT NULL CHECK (octet_length(metadata_json) <= 4096),
  result_json TEXT CHECK (octet_length(result_json) <= 524288),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (grant_id,request_key),
  FOREIGN KEY (grant_id,owner_user_id) REFERENCES app.meeting_capture_grants(id,owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_capture_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_receipts_owner ON app.meeting_capture_receipts FOR ALL TO jarvis_app_runtime USING (owner_user_id=app.current_actor_user_id()) WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT ON app.meeting_capture_receipts TO jarvis_app_runtime;
GRANT UPDATE (result_json) ON app.meeting_capture_receipts TO jarvis_app_runtime;

-- Capture account export
CREATE POLICY meeting_capture_grants_export_worker ON app.meeting_capture_grants
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
GRANT SELECT (id, meeting_id, owner_user_id, device_name, status, state_json, created_at, expires_at)
  ON app.meeting_capture_grants TO jarvis_worker_runtime;
