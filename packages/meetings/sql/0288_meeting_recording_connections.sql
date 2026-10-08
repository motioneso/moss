-- Legacy per-meeting approvals cannot become recording-capability grants.
-- The canonical runner encloses this in one transaction; its owner role has NOBYPASSRLS.
ALTER TABLE app.meeting_capture_grants DISABLE ROW LEVEL SECURITY;
UPDATE app.meeting_capture_grants SET status='revoked' WHERE status<>'revoked';
ALTER TABLE app.meeting_capture_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_grants FORCE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_grants
  DROP CONSTRAINT meeting_capture_grants_status_check,
  ADD CONSTRAINT meeting_capture_grants_status_check CHECK (status IN ('pending','approved','active','finalizing','complete','revoked')),
  ADD COLUMN connection_id UUID,
  ADD COLUMN capability_revision INTEGER CHECK (capability_revision>0),
  ADD COLUMN claim_expires_at TIMESTAMPTZ(3),
  ADD COLUMN start_request_key UUID,
  ADD COLUMN start_fingerprint TEXT CHECK (start_fingerprint ~ '^[a-f0-9]{64}$');
GRANT UPDATE (connection_id,capability_revision,claim_expires_at,start_request_key,start_fingerprint)
  ON app.meeting_capture_grants TO jarvis_app_runtime;
DROP INDEX app.meeting_capture_one_active;
CREATE UNIQUE INDEX meeting_capture_one_active ON app.meeting_capture_grants (meeting_id)
  WHERE status IN ('approved','active');
CREATE UNIQUE INDEX meeting_capture_one_device_connection ON app.meeting_capture_grants (owner_user_id,device_id,connection_id)
  WHERE status IN ('approved','active');
CREATE UNIQUE INDEX meeting_capture_start_request ON app.meeting_capture_grants (owner_user_id,start_request_key)
  WHERE start_request_key IS NOT NULL;

-- Exactly one launch generation per owner/device, with native-held ephemeral proof.
CREATE TABLE app.meeting_capture_connections (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  device_name TEXT NOT NULL CHECK (octet_length(device_name) BETWEEN 1 AND 256),
  verifier_hash TEXT NOT NULL CHECK (verifier_hash ~ '^[a-f0-9]{64}$'),
  capability_revision INTEGER NOT NULL CHECK (capability_revision>0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision>0),
  inventory_json TEXT NOT NULL CHECK (octet_length(inventory_json)<=131072),
  last_seen_at TIMESTAMPTZ(3) NOT NULL,
  expires_at TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (owner_user_id,device_id)
);
ALTER TABLE app.meeting_capture_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_connections_owner ON app.meeting_capture_connections
  FOR ALL TO jarvis_app_runtime USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,UPDATE,DELETE ON app.meeting_capture_connections TO jarvis_app_runtime;

ALTER TABLE app.meeting_capture_receipts
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 4),
  ADD COLUMN retry_at TIMESTAMPTZ(3);
GRANT UPDATE (attempts,retry_at) ON app.meeting_capture_receipts TO jarvis_app_runtime;

-- Cancellation is a durable metadata fence, including Start requests not yet received.
CREATE TABLE app.meeting_capture_start_cancellations (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  meeting_id UUID NOT NULL,
  device_id UUID NOT NULL,
  connection_id UUID NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id,request_key),
  FOREIGN KEY (meeting_id,owner_user_id) REFERENCES app.meeting_records(id,owner_user_id) ON DELETE CASCADE
);
ALTER TABLE app.meeting_capture_start_cancellations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_capture_start_cancellations FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_capture_start_cancellations_owner ON app.meeting_capture_start_cancellations
  FOR ALL TO jarvis_app_runtime USING (owner_user_id=app.current_actor_user_id())
  WITH CHECK (owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_capture_start_cancellations TO jarvis_app_runtime;

-- Capture connection account export: no verifier, credential, session, or launch proof material.
CREATE POLICY meeting_capture_connections_export_worker ON app.meeting_capture_connections
  FOR SELECT TO jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
GRANT SELECT (device_id, owner_user_id, device_name, inventory_json, last_seen_at, expires_at)
  ON app.meeting_capture_connections TO jarvis_worker_runtime;
CREATE POLICY meeting_capture_start_cancellations_export_worker ON app.meeting_capture_start_cancellations
  FOR SELECT TO jarvis_worker_runtime USING (owner_user_id=app.current_actor_user_id());
GRANT SELECT (meeting_id, owner_user_id, request_key, created_at)
  ON app.meeting_capture_start_cancellations TO jarvis_worker_runtime;
