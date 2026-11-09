CREATE TABLE app.notes_sync_checkpoints (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  checkpoint JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
