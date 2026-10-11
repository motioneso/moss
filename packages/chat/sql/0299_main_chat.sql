-- #3125: Main chat is a durable owner designation, separate from side-chat activity.
ALTER TABLE app.chat_threads
  ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'app.chat_threads'::regclass
      AND conname = 'chat_threads_main_eligible'
  ) THEN
    ALTER TABLE app.chat_threads
      ADD CONSTRAINT chat_threads_main_eligible
      CHECK (NOT is_main OR (surface = 'drawer' AND incognito = false));
  END IF;
END;
$$;

-- Same one-transaction backfill pattern as 0209: migration_owner is NOBYPASSRLS
-- and chat_threads forces RLS, so temporarily disable it only while upgrading rows.
ALTER TABLE app.chat_threads DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_threads DISABLE TRIGGER chat_threads_enforce_update_scope;

WITH ranked AS (
  SELECT id,
    row_number() OVER (
      PARTITION BY owner_user_id
      ORDER BY last_active_at DESC, id ASC
    ) AS rank
  FROM app.chat_threads
  WHERE surface = 'drawer' AND incognito = false
)
UPDATE app.chat_threads thread
SET is_main = true
FROM ranked
WHERE thread.id = ranked.id AND ranked.rank = 1;

ALTER TABLE app.chat_threads ENABLE TRIGGER chat_threads_enforce_update_scope;
ALTER TABLE app.chat_threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_threads FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_one_main_per_owner_idx
  ON app.chat_threads (owner_user_id)
  WHERE is_main;

CREATE OR REPLACE FUNCTION app.enforce_chat_thread_update_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.owner_user_id = app.current_actor_user_id() THEN
    RETURN NEW;
  END IF;

  IF NEW.is_main IS DISTINCT FROM OLD.is_main THEN
    RAISE EXCEPTION 'only the chat owner can change the Main chat';
  END IF;

  IF NEW.title <> OLD.title THEN
    RAISE EXCEPTION 'workspace chat participants cannot change chat thread title';
  END IF;

  IF NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'workspace chat participants cannot move chat thread updated_at backwards';
  END IF;

  RETURN NEW;
END;
$$;
