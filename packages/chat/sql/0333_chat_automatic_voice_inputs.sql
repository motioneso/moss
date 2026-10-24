-- Only new admissions opt into automatic delivery. Retained receipts preserve their policy.
ALTER TABLE app.chat_voice_requests ADD COLUMN auto_send boolean NOT NULL DEFAULT false;
GRANT SELECT (auto_send) ON app.chat_voice_requests TO jarvis_worker_runtime;
