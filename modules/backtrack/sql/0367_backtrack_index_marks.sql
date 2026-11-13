CREATE TABLE app.backtrack_index_marks (
  segment_id UUID PRIMARY KEY,
  owner_user_id UUID NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  indexed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
