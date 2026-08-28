-- #2006: distinguish a rejected publisher key from a temporary source outage.
-- Existing rows are kept; only their health meaning changes.

UPDATE app.news_custom_sources
   SET health_status = CASE health_status
     WHEN 'available' THEN 'healthy'
     WHEN 'unavailable' THEN 'temporarily_unavailable'
     ELSE health_status
   END;

ALTER TABLE app.news_custom_sources
  ALTER COLUMN health_status SET DEFAULT 'healthy';

ALTER TABLE app.news_custom_sources
  DROP CONSTRAINT IF EXISTS news_custom_sources_health_status_check;

ALTER TABLE app.news_custom_sources
  ADD CONSTRAINT news_custom_sources_health_status_check
  CHECK (health_status IN (
    'healthy',
    'authentication_failed',
    'temporarily_unavailable',
    'unsupported',
    'disabled'
  ));

-- The worker already has this narrow grant from 0160; repeat it here so the final
-- health-state migration remains correct on installs that apply migrations incrementally.
GRANT UPDATE (health_status) ON app.news_custom_sources TO jarvis_worker_runtime;

-- The refresh worker needs only the encrypted envelope and its routing metadata. It never
-- receives credential-management timestamps or any other owner data.
GRANT SELECT (source_id, connection_id, encrypted_secret, status, generation)
  ON app.news_source_credentials TO jarvis_worker_runtime;
DROP POLICY IF EXISTS news_source_credentials_worker_select ON app.news_source_credentials;
CREATE POLICY news_source_credentials_worker_select ON app.news_source_credentials
  FOR SELECT TO jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id());
