-- #2570 Trail Marker focus judgments. Platform table (focus is not a module): owner-only rows,
-- written and read by the API app on behalf of a linked Mac.
--
-- There is deliberately NO column for a window title, an app name, an image description or the
-- calendar block's title. What the person was looking at is never stored; `reason` is the model's
-- short category-level note and is the one free-text field that is kept.
CREATE TABLE app.focus_judgments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  -- Opaque reference to the linked Mac. No foreign key on purpose: the devices table is readable
  -- by the auth runtime role only, and this table must not couple to its shape. A deleted device
  -- leaves a dangling id, which is harmless because nothing joins on it.
  device_id uuid,
  block_ref text NOT NULL,
  label text NOT NULL CHECK (label IN ('focused', 'necessary_detour', 'distracted', 'insufficient_evidence')),
  reason text NOT NULL CHECK (char_length(reason) <= 140),
  nudged boolean NOT NULL DEFAULT false,
  correction text CHECK (correction IN ('right', 'wrong')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX focus_judgments_owner_created_idx ON app.focus_judgments (owner_user_id, created_at DESC);
CREATE INDEX focus_judgments_owner_block_created_idx ON app.focus_judgments (owner_user_id, block_ref, created_at DESC);

ALTER TABLE app.focus_judgments ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.focus_judgments FORCE ROW LEVEL SECURITY;

CREATE POLICY focus_judgments_rw ON app.focus_judgments FOR ALL
  TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

-- App runtime only. No worker grant: slice 1 judges inside the Mac's own request, never in a job.
GRANT SELECT, INSERT, UPDATE ON app.focus_judgments TO jarvis_app_runtime;
