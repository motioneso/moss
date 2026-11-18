CREATE TABLE app.memory_reembed_staged (
  run_id UUID NOT NULL REFERENCES app.memory_reembed_runs(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('chunk','document')),
  target_id UUID NOT NULL,
  text_hash TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  PRIMARY KEY (run_id, target_kind, target_id)
);
