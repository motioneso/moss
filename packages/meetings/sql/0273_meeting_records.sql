-- #2981: persisted draft identity and personal notes only. No capture or provider processing.
CREATE TABLE app.meeting_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  request_key UUID NOT NULL,
  title TEXT NOT NULL CHECK (octet_length(title) BETWEEN 1 AND 240 AND btrim(title) <> ''),
  personal_notes TEXT NOT NULL DEFAULT '' CHECK (octet_length(personal_notes) <= 64000),
  notes_revision INTEGER NOT NULL DEFAULT 0 CHECK (notes_revision >= 0),
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, request_key),
  UNIQUE (id, owner_user_id)
);

CREATE INDEX meeting_records_owner_created
  ON app.meeting_records (owner_user_id, created_at DESC, id DESC);

ALTER TABLE app.meeting_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_records FORCE ROW LEVEL SECURITY;

CREATE POLICY meeting_records_owner ON app.meeting_records
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT ON app.meeting_records TO jarvis_app_runtime;
-- Creation input stays immutable so create retries can be compared after notes are edited.
GRANT UPDATE (personal_notes, notes_revision, updated_at) ON app.meeting_records TO jarvis_app_runtime;

-- Retry receipts contain private note versions and have the same owner and deletion lifecycle.
CREATE TABLE app.meeting_note_writes (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision BETWEEN 0 AND 2147483646),
  personal_notes TEXT NOT NULL CHECK (octet_length(personal_notes) <= 64000),
  saved_at TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY (meeting_id, request_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id)
    ON DELETE CASCADE
);

ALTER TABLE app.meeting_note_writes ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_note_writes FORCE ROW LEVEL SECURITY;

CREATE POLICY meeting_note_writes_owner ON app.meeting_note_writes
  FOR ALL TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT ON app.meeting_note_writes TO jarvis_app_runtime;
