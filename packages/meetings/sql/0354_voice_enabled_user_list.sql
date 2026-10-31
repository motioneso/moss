-- #3854: chat keeps the main session warm for users with hold-to-talk on. The enablement table is
-- owner-only under forced row security, so the cross-user list is a definer function that returns
-- user ids and nothing else. Forced row security also binds the function owner, so the owner gets a
-- read policy, as in chat 0146.

DROP POLICY IF EXISTS meeting_recording_voice_enablements_keep_warm_list ON app.meeting_recording_voice_enablements;
CREATE POLICY meeting_recording_voice_enablements_keep_warm_list
ON app.meeting_recording_voice_enablements
FOR SELECT
TO jarvis_migration_owner
USING (true);

CREATE OR REPLACE FUNCTION app.list_voice_enabled_user_ids()
RETURNS TABLE(user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = app, pg_temp
AS $$
  SELECT DISTINCT owner_user_id
  FROM app.meeting_recording_voice_enablements
  WHERE disabled_at IS NULL
$$;

REVOKE ALL ON FUNCTION app.list_voice_enabled_user_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_voice_enabled_user_ids() TO jarvis_app_runtime;
