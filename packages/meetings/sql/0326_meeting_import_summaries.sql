-- Imported completion is an independent automatic-summary trigger, never a capture grant.
ALTER TABLE app.meeting_recording_imports
  ADD CONSTRAINT meeting_recording_imports_summary_identity UNIQUE (id,meeting_id,owner_user_id);
ALTER TABLE app.meeting_stop_summaries
  ALTER COLUMN grant_id DROP NOT NULL,
  ADD COLUMN recording_import_id UUID,
  ADD COLUMN transcript_revision INTEGER CHECK (transcript_revision >= 0),
  ADD CONSTRAINT meeting_automatic_summary_source CHECK ((grant_id IS NOT NULL AND recording_import_id IS NULL AND transcript_revision IS NULL) OR (grant_id IS NULL AND recording_import_id IS NOT NULL AND transcript_revision IS NOT NULL)),
  ADD CONSTRAINT meeting_automatic_summary_import FOREIGN KEY (recording_import_id,meeting_id,owner_user_id)
    REFERENCES app.meeting_recording_imports(id,meeting_id,owner_user_id) ON DELETE CASCADE;
GRANT SELECT (recording_import_id,transcript_revision) ON app.meeting_stop_summaries TO jarvis_worker_runtime;
-- API-owned import workers use the app actor for admission and output receipts.
GRANT UPDATE (input_json) ON app.meeting_stop_summaries TO jarvis_app_runtime;
