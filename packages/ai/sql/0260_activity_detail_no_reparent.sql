-- #2956 round 3: a detail row can never move to another line.
--
-- The lock trigger froze the owner and the expiry but not activity_id, so an
-- owner could re-parent their row onto someone else's line (the foreign key
-- ignores row security) and block that person's detail slot. Freeze
-- activity_id too. This supersedes 0258's note that UPDATE needs no sync.

CREATE OR REPLACE FUNCTION app.moss_activity_detail_lock_owner()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.activity_id IS DISTINCT FROM OLD.activity_id THEN
    RAISE EXCEPTION 'moss_activity_detail: owner_user_id, expires_at and activity_id are immutable';
  END IF;
  RETURN NEW;
END;
$$;
