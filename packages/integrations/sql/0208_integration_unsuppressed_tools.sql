ALTER TABLE app.integration_connections
  ADD COLUMN unsuppressed_tools text[] NOT NULL DEFAULT '{}';
