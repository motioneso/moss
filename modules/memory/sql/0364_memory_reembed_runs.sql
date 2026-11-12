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
