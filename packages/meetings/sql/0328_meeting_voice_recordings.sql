-- Completed voice audio belongs to the recording receiver; Chat owns its transcript and turn.
CREATE TABLE app.meeting_recording_voice_enablements (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id() REFERENCES app.users(id) ON DELETE CASCADE,
  source_device_id UUID NOT NULL,
  request_key UUID NOT NULL,
  inventory_json TEXT NOT NULL CHECK(octet_length(inventory_json) <= 98304),
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  disabled_at TIMESTAMPTZ,
  UNIQUE(owner_user_id,source_device_id,request_key),
  UNIQUE(id,owner_user_id,source_device_id)
);
CREATE UNIQUE INDEX meeting_recording_voice_active ON app.meeting_recording_voice_enablements(owner_user_id,source_device_id) WHERE disabled_at IS NULL;
ALTER TABLE app.meeting_recording_voice_enablements ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_recording_voice_enablements FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_recording_voice_owner ON app.meeting_recording_voice_enablements FOR ALL TO jarvis_app_runtime
  USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id());
GRANT SELECT,INSERT,DELETE ON app.meeting_recording_voice_enablements TO jarvis_app_runtime;
GRANT UPDATE(disabled_at) ON app.meeting_recording_voice_enablements TO jarvis_app_runtime;
CREATE POLICY meeting_recording_voice_enablements_export_worker ON app.meeting_recording_voice_enablements FOR SELECT TO jarvis_worker_runtime
  USING(owner_user_id=app.current_actor_user_id());
GRANT SELECT(id,owner_user_id,source_device_id,request_key,inventory_json,enabled_at,disabled_at) ON app.meeting_recording_voice_enablements TO jarvis_worker_runtime;

ALTER TABLE app.meeting_recording_imports ALTER COLUMN meeting_id DROP NOT NULL;
ALTER TABLE app.meeting_recording_imports
  ADD COLUMN voice_enablement_id UUID,
  ADD COLUMN voice_automatic BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN voice_captured_at TIMESTAMPTZ,
  ADD COLUMN voice_request_id UUID,
  ADD CONSTRAINT meeting_recording_voice_source FOREIGN KEY(voice_enablement_id,owner_user_id,source_device_id)
    REFERENCES app.meeting_recording_voice_enablements(id,owner_user_id,source_device_id),
  ADD CONSTRAINT meeting_recording_destination CHECK (
    (meeting_id IS NOT NULL AND voice_enablement_id IS NULL AND NOT voice_automatic AND voice_captured_at IS NULL AND voice_request_id IS NULL) OR
    (meeting_id IS NULL AND voice_enablement_id IS NOT NULL AND (state <> 'complete' OR voice_request_id IS NOT NULL))
  );
GRANT UPDATE(voice_request_id) ON app.meeting_recording_imports TO jarvis_app_runtime;
GRANT SELECT(voice_enablement_id,voice_automatic,voice_captured_at,voice_request_id) ON app.meeting_recording_imports TO jarvis_worker_runtime;
