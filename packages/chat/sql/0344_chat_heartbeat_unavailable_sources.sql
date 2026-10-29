-- Sources a check could not read, kept on the occurrence so Settings can show them.
ALTER TABLE app.heartbeat_occurrences
  ADD COLUMN unavailable_sources text[] NOT NULL DEFAULT '{}';
