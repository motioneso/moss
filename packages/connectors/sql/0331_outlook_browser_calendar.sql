CREATE POLICY connector_definitions_outlook_seed ON app.connector_definitions
  TO jarvis_migration_owner USING (true) WITH CHECK (true);

INSERT INTO app.connector_definitions (provider_id, provider_type, display_name, status, default_scopes)
VALUES ('outlook-browser-calendar', 'calendar', 'Outlook calendar (browser)', 'available', ARRAY['calendar.readonly']::text[])
ON CONFLICT (provider_id) DO NOTHING;

DROP POLICY connector_definitions_outlook_seed ON app.connector_definitions;

CREATE UNIQUE INDEX connector_accounts_outlook_owner_idx
  ON app.connector_accounts (owner_user_id)
  WHERE provider_id = 'outlook-browser-calendar';
