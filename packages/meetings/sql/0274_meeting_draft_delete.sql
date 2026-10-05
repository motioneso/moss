-- Draft deletion remains subject to the existing forced owner policy.
-- Immutable note-write receipts cascade through their composite foreign key.
GRANT DELETE ON app.meeting_records TO jarvis_app_runtime;
