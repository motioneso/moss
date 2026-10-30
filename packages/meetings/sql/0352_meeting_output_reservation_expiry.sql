-- Long summaries take several model calls, so a generation reservation must
-- outlive the old two minute default. The worker role reserves generation
-- requests and needs to set the longer expiry on insert.
GRANT INSERT (expires_at) ON app.meeting_output_requests TO jarvis_worker_runtime;
