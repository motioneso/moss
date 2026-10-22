-- Managed-browser lifecycle metadata. No cookies, addresses, frames or input are stored here.
CREATE TABLE app.connector_outlook_setups (
  owner_user_id uuid PRIMARY KEY REFERENCES app.users(id) ON DELETE CASCADE,
  runtime_id uuid NOT NULL UNIQUE,
  generation integer NOT NULL DEFAULT 1 CHECK (generation > 0),
  state text NOT NULL CHECK (state IN (
    'preparing', 'sign-in', 'confirm', 'active', 'sign-in-needed', 'source-changed',
    'removing', 'cleanup-failed', 'removed'
  )),
  identity_hash text CHECK (identity_hash IS NULL OR identity_hash ~ '^[a-f0-9]{64}$'),
  setup_expires_at timestamptz NOT NULL,
  lease_id uuid,
  lease_kind text CHECK (lease_kind IN ('viewer', 'collector')),
  lease_session_id uuid,
  lease_expires_at timestamptz,
  lease_absolute_expires_at timestamptz,
  lease_activity_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (lease_id IS NULL AND lease_kind IS NULL AND lease_session_id IS NULL
      AND lease_expires_at IS NULL AND lease_absolute_expires_at IS NULL AND lease_activity_at IS NULL)
    OR
    (lease_id IS NOT NULL AND lease_kind IS NOT NULL AND lease_expires_at IS NOT NULL
      AND lease_absolute_expires_at IS NOT NULL AND lease_activity_at IS NOT NULL
      AND ((lease_kind = 'viewer' AND lease_session_id IS NOT NULL)
        OR (lease_kind = 'collector' AND lease_session_id IS NULL)))
  ),
  CHECK (state NOT IN ('removing', 'cleanup-failed', 'removed') OR lease_id IS NULL),
  CHECK (state <> 'active' OR identity_hash IS NOT NULL)
);

-- Intentionally no FK to users/setups: deleting the owner must not lose profile removal work.
-- Rows disappear after removal is confirmed. Only fixed worker functions can dispatch/ack them.
CREATE TABLE app.connector_outlook_cleanup (
  runtime_id uuid PRIMARY KEY,
  generation integer NOT NULL CHECK (generation > 0),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_id uuid,
  claim_expires_at timestamptz,
  CHECK ((claim_id IS NULL) = (claim_expires_at IS NULL))
);

ALTER TABLE app.connector_outlook_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_outlook_setups FORCE ROW LEVEL SECURITY;
ALTER TABLE app.connector_outlook_cleanup ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.connector_outlook_cleanup FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON app.connector_outlook_setups TO jarvis_app_runtime;
GRANT SELECT, UPDATE ON app.connector_outlook_setups TO jarvis_worker_runtime;
CREATE POLICY connector_outlook_setups_owner ON app.connector_outlook_setups
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
CREATE POLICY connector_outlook_setups_lifecycle ON app.connector_outlook_setups
  TO jarvis_migration_owner USING (true) WITH CHECK (true);
CREATE POLICY connector_outlook_cleanup_lifecycle ON app.connector_outlook_cleanup
  TO jarvis_migration_owner USING (true) WITH CHECK (true);

CREATE FUNCTION app.enqueue_outlook_browser_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.state <> 'removed' THEN
      INSERT INTO app.connector_outlook_cleanup (runtime_id, generation)
      VALUES (OLD.runtime_id, OLD.generation + 1)
      ON CONFLICT (runtime_id) DO UPDATE
        SET generation = GREATEST(connector_outlook_cleanup.generation, EXCLUDED.generation);
    END IF;
    RETURN OLD;
  END IF;
  IF NEW.state = 'removing' THEN
    INSERT INTO app.connector_outlook_cleanup (runtime_id, generation)
    VALUES (NEW.runtime_id, NEW.generation)
    ON CONFLICT (runtime_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION app.enqueue_outlook_browser_cleanup() FROM PUBLIC;
CREATE TRIGGER connector_outlook_cleanup_on_revoke
  AFTER UPDATE OF state ON app.connector_outlook_setups
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_outlook_browser_cleanup();
CREATE TRIGGER connector_outlook_cleanup_on_delete
  AFTER DELETE ON app.connector_outlook_setups
  FOR EACH ROW EXECUTE FUNCTION app.enqueue_outlook_browser_cleanup();

CREATE FUNCTION app.claim_outlook_browser_cleanup()
RETURNS TABLE(runtime_id uuid, generation integer, claim_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  UPDATE app.connector_outlook_cleanup AS work
  SET claim_id = gen_random_uuid(), claim_expires_at = now() + interval '2 minutes',
      attempts = LEAST(work.attempts + 1, 1000000)
  WHERE work.runtime_id IN (
    SELECT pending.runtime_id FROM app.connector_outlook_cleanup AS pending
    WHERE pending.next_attempt_at <= now()
      AND (pending.claim_expires_at IS NULL OR pending.claim_expires_at <= now())
    ORDER BY pending.next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED
  )
  RETURNING work.runtime_id, work.generation, work.claim_id;
$$;

CREATE FUNCTION app.finish_outlook_browser_cleanup(p_runtime_id uuid, p_claim_id uuid, p_removed boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
DECLARE work app.connector_outlook_cleanup;
BEGIN
  SELECT * INTO work FROM app.connector_outlook_cleanup
  WHERE runtime_id = p_runtime_id AND claim_id = p_claim_id AND claim_expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  UPDATE app.connector_outlook_setups
  SET state = CASE WHEN p_removed THEN 'removed' ELSE 'cleanup-failed' END, updated_at = now()
  WHERE runtime_id = work.runtime_id AND generation = work.generation
    AND state IN ('removing', 'cleanup-failed');
  IF p_removed THEN
    DELETE FROM app.connector_outlook_cleanup WHERE runtime_id = work.runtime_id;
  ELSE
    UPDATE app.connector_outlook_cleanup
    SET claim_id = NULL, claim_expires_at = NULL,
        next_attempt_at = now() + make_interval(secs => LEAST(900, 15 * power(2, LEAST(work.attempts, 6)))::integer)
    WHERE runtime_id = work.runtime_id;
  END IF;
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION app.claim_outlook_browser_cleanup() FROM PUBLIC;
REVOKE ALL ON FUNCTION app.finish_outlook_browser_cleanup(uuid, uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.claim_outlook_browser_cleanup(),
  app.finish_outlook_browser_cleanup(uuid, uuid, boolean) TO jarvis_worker_runtime;

CREATE FUNCTION app.list_expired_outlook_setup_actors()
RETURNS TABLE(actor_user_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, app AS $$
  SELECT owner_user_id FROM app.connector_outlook_setups
  WHERE state IN ('preparing', 'sign-in', 'confirm') AND setup_expires_at <= now()
  ORDER BY setup_expires_at LIMIT 500;
$$;
REVOKE ALL ON FUNCTION app.list_expired_outlook_setup_actors() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.list_expired_outlook_setup_actors() TO jarvis_worker_runtime;
