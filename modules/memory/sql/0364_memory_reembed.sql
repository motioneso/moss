CREATE TABLE app.memory_reembed_runs (
  id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','done','cancelled','failed')),
  model_name TEXT NOT NULL CHECK (char_length(model_name) BETWEEN 1 AND 256),
  model_version TEXT NOT NULL CHECK (char_length(model_version) BETWEEN 1 AND 64),
  total INTEGER NOT NULL CHECK (total >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX memory_reembed_one_running
  ON app.memory_reembed_runs (owner_user_id) WHERE status = 'running';

CREATE TABLE app.memory_reembed_staged (
  run_id UUID NOT NULL REFERENCES app.memory_reembed_runs(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('chunk','document')),
  target_id UUID NOT NULL,
  text_hash TEXT NOT NULL,
  embedding vector(768) NOT NULL,
  PRIMARY KEY (run_id, target_kind, target_id)
);
