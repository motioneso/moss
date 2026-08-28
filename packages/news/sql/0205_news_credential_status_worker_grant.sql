-- #2006 QA fix: complete the worker's narrow credential-status read grant.
-- readStatuses selects these metadata columns and orders by created_at. The existing
-- grant in 0204 already covers source_id, connection_id, status, encrypted_secret, and
-- generation; keep the worker limited to exactly what the status query needs.

GRANT SELECT (last_validated_at, revoked_at, created_at)
  ON app.news_source_credentials TO jarvis_worker_runtime;
