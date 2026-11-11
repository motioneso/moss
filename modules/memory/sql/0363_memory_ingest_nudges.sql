CREATE TABLE app.memory_ingest_nudges (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  source_path TEXT NOT NULL CHECK (octet_length(source_path) BETWEEN 1 AND 1024),
  op TEXT NOT NULL CHECK (op IN ('upsert','delete')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
