-- Fact UUIDs survive live-row deletion. Owner cascade is the final retirement boundary.
CREATE TABLE app.memory_recording_fact_versions (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  fact_id UUID NOT NULL,
  lineage_id UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  side TEXT NOT NULL CHECK (side IN ('personal','work')),
  state TEXT NOT NULL DEFAULT 'current' CHECK (state IN ('current','superseded','forgotten')),
  corrected BOOLEAN NOT NULL DEFAULT false,
  replacement_fact_id UUID,
  PRIMARY KEY(owner_user_id,fact_id),
  CHECK (replacement_fact_id IS NULL OR replacement_fact_id <> fact_id)
);

CREATE TABLE app.memory_recording_receipts (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  receipt_id TEXT NOT NULL CHECK (receipt_id ~ '^[a-f0-9]{64}$'),
  source_module_id TEXT NOT NULL CHECK (source_module_id = 'meetings'),
  source_id UUID NOT NULL,
  source_version INTEGER NOT NULL CHECK (source_version >= 1),
  item_key TEXT NOT NULL CHECK (item_key ~ '^[a-zA-Z0-9_-]{1,80}$'),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  side TEXT NOT NULL CHECK (side IN ('personal','work')),
  state TEXT NOT NULL CHECK (state IN ('pending','applied','undone','forgotten')),
  fact_id UUID,
  episode_id UUID NOT NULL,
  PRIMARY KEY(owner_user_id,receipt_id),
  UNIQUE(owner_user_id,source_module_id,source_id,source_version,item_key),
  UNIQUE(owner_user_id,episode_id),
  FOREIGN KEY(owner_user_id,fact_id)
    REFERENCES app.memory_recording_fact_versions(owner_user_id,fact_id) ON DELETE CASCADE,
  CHECK (state <> 'applied' OR fact_id IS NOT NULL)
);
CREATE INDEX memory_recording_receipts_fact ON app.memory_recording_receipts(owner_user_id,fact_id);

CREATE TABLE app.memory_recording_proposals (
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id()
    REFERENCES app.users(id) ON DELETE CASCADE,
  proposal_id UUID NOT NULL,
  request_id TEXT NOT NULL CHECK (octet_length(request_id) BETWEEN 1 AND 256),
  input_digest TEXT NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
  receipt_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('apply','change','undo','restore','reconcile_side')),
  expected_receipt_revision INTEGER NOT NULL CHECK (expected_receipt_revision >= 1),
  expected_fact_id UUID,
  expected_fact_revision BIGINT,
  actor_generation INTEGER NOT NULL CHECK (actor_generation >= 0),
  source_generation INTEGER NOT NULL CHECK (source_generation >= 0),
  side TEXT NOT NULL CHECK (side IN ('personal','work')),
  proposed_text TEXT CHECK (octet_length(proposed_text) BETWEEN 1 AND 2048),
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared','applied')),
  publication_snapshot JSONB NOT NULL,
  before JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_user_id,proposal_id),
  UNIQUE(owner_user_id,request_id),
  FOREIGN KEY(owner_user_id,receipt_id)
    REFERENCES app.memory_recording_receipts(owner_user_id,receipt_id) ON DELETE CASCADE,
  CHECK ((expected_fact_id IS NULL) = (expected_fact_revision IS NULL)),
  CHECK ((kind IN ('apply','change')) = (proposed_text IS NOT NULL))
);

ALTER TABLE app.memory_recording_fact_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_recording_fact_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_recording_fact_versions_owner ON app.memory_recording_fact_versions
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
-- Referential actions run as the owning table role. They retain the same actor scope.
CREATE POLICY memory_recording_fact_versions_referential_owner ON app.memory_recording_fact_versions
  FOR ALL TO jarvis_migration_owner
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
ALTER TABLE app.memory_recording_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_recording_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_recording_receipts_owner ON app.memory_recording_receipts
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
ALTER TABLE app.memory_recording_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.memory_recording_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY memory_recording_proposals_owner ON app.memory_recording_proposals
  FOR ALL TO jarvis_app_runtime,jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT,INSERT,UPDATE ON app.memory_recording_fact_versions
  TO jarvis_app_runtime,jarvis_worker_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON app.memory_recording_receipts,app.memory_recording_proposals
  TO jarvis_app_runtime,jarvis_worker_runtime;

ALTER TABLE app.memory_facts ADD COLUMN recording_side TEXT
  CHECK (recording_side IN ('personal','work'));
ALTER TABLE app.memory_episodes ADD COLUMN recording_side TEXT
  CHECK (recording_side IN ('personal','work'));
ALTER TABLE app.memory_episodes ADD COLUMN recording_active BOOLEAN;
ALTER TABLE app.memory_search_documents ADD COLUMN recording_side TEXT
  CHECK (recording_side IN ('personal','work'));
ALTER TABLE app.memory_search_documents ADD COLUMN recording_revision BIGINT;

-- These triggers only retain local version state. They never acquire source admission,
-- mutate receipts, or touch search documents (approved forget preserves NOWAIT there).
CREATE FUNCTION app.memory_recording_version_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF NEW.owner_user_id <> OLD.owner_user_id OR NEW.fact_id <> OLD.fact_id
     OR NEW.lineage_id <> OLD.lineage_id
     OR NEW.revision < OLD.revision
     OR (OLD.state <> 'current' AND (NEW.state <> OLD.state OR NEW.side <> OLD.side
       OR NEW.replacement_fact_id IS DISTINCT FROM OLD.replacement_fact_id))
     OR (OLD.corrected AND NOT NEW.corrected) THEN
    RAISE EXCEPTION 'Recording fact history cannot be reset' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_recording_version_transition BEFORE UPDATE
  ON app.memory_recording_fact_versions FOR EACH ROW
  EXECUTE FUNCTION app.memory_recording_version_transition();

CREATE FUNCTION app.memory_recording_fact_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE version_state TEXT;
DECLARE version_side TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    UPDATE app.memory_recording_fact_versions
    SET revision = revision + 1,
        state = CASE WHEN state = 'current' THEN 'forgotten' ELSE state END
    WHERE owner_user_id = OLD.owner_user_id AND fact_id = OLD.id;
    RETURN OLD;
  END IF;
  -- FK cleanup clears only this nullable pointer. It cannot revive an already retired
  -- predecessor, and its durable replacement identity must survive the clearing.
  IF TG_OP = 'UPDATE' AND OLD.status = 'superseded' AND NEW.status = 'superseded'
     AND OLD.superseded_by_fact_id IS NOT NULL AND NEW.superseded_by_fact_id IS NULL
     AND (to_jsonb(NEW) - 'superseded_by_fact_id') = (to_jsonb(OLD) - 'superseded_by_fact_id') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.recording_side IS NOT NULL AND NEW.recording_side IS NULL THEN
    RAISE EXCEPTION 'Recording fact label cannot be removed' USING ERRCODE = '23514';
  END IF;
  SELECT state,side INTO version_state,version_side
  FROM app.memory_recording_fact_versions
  WHERE owner_user_id = NEW.owner_user_id AND fact_id = NEW.id;
  IF version_state IS NULL THEN
    IF NEW.recording_side IS NOT NULL THEN
      RAISE EXCEPTION 'Recording fact history is missing' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.recording_side IS DISTINCT FROM version_side
     OR (NEW.status IN ('active','conflicting','stale') AND version_state <> 'current') THEN
    RAISE EXCEPTION 'Retired recording fact cannot be activated' USING ERRCODE = '23514';
  END IF;
  UPDATE app.memory_recording_fact_versions
  SET revision = revision + 1,
      state = CASE WHEN NEW.status = 'superseded' THEN 'superseded' ELSE state END,
      replacement_fact_id = CASE WHEN NEW.status = 'superseded'
        THEN COALESCE(NEW.superseded_by_fact_id,replacement_fact_id) ELSE replacement_fact_id END
  WHERE owner_user_id = NEW.owner_user_id AND fact_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_recording_fact_transition BEFORE INSERT OR UPDATE OR DELETE
  ON app.memory_facts FOR EACH ROW EXECUTE FUNCTION app.memory_recording_fact_transition();

ALTER TABLE app.memory_episodes ADD CONSTRAINT memory_recording_episode_label
  CHECK ((recording_side IS NULL) = (recording_active IS NULL));
ALTER TABLE app.memory_search_documents ADD CONSTRAINT memory_recording_document_label
  CHECK ((recording_side IS NULL) = (recording_revision IS NULL));

-- Read eligibility is independent of a derivative's stored active flag. A direct retirement
-- may leave that flag unchanged; callers must filter through this local eligibility check.
CREATE FUNCTION app.memory_recording_fact_eligible(actor UUID,target UUID,label TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM app.memory_recording_fact_versions version
    JOIN app.memory_facts fact ON fact.owner_user_id = version.owner_user_id AND fact.id = version.fact_id
    WHERE version.owner_user_id = actor AND version.fact_id = target
      AND version.state = 'current' AND version.side = label AND fact.recording_side = label
      AND fact.status IN ('active','conflicting','stale')
      AND EXISTS (
        SELECT 1 FROM app.memory_recording_receipts receipt
        WHERE receipt.owner_user_id = actor AND receipt.fact_id = target
          AND receipt.state = 'applied' AND receipt.side = label
      )
  );
$$;

CREATE FUNCTION app.memory_recording_target_revision(actor UUID,kind TEXT,target UUID,label TEXT)
RETURNS BIGINT LANGUAGE sql STABLE SET search_path = pg_catalog, app, pg_temp AS $$
  SELECT CASE
    WHEN kind = 'fact' THEN (
      SELECT revision FROM app.memory_recording_fact_versions
      WHERE owner_user_id = actor AND fact_id = target
        AND app.memory_recording_fact_eligible(actor,target,label)
    )
    WHEN kind = 'episode' THEN (
      SELECT version.revision FROM app.memory_recording_receipts receipt
      JOIN app.memory_recording_fact_versions version
        ON version.owner_user_id = receipt.owner_user_id AND version.fact_id = receipt.fact_id
      JOIN app.memory_episodes episode
        ON episode.owner_user_id = receipt.owner_user_id AND episode.id = receipt.episode_id
      JOIN app.memory_fact_sources source
        ON source.owner_user_id = receipt.owner_user_id AND source.fact_id = receipt.fact_id
          AND source.episode_id = receipt.episode_id
      WHERE receipt.owner_user_id = actor AND receipt.episode_id = target
        AND receipt.state = 'applied' AND receipt.side = label
        AND episode.recording_side = label AND episode.recording_active
        AND app.memory_recording_fact_eligible(actor,receipt.fact_id,label)
    )
    ELSE NULL
  END;
$$;

CREATE FUNCTION app.memory_recording_derivative_label() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
BEGIN
  IF OLD.recording_side IS NOT NULL AND NEW.recording_side IS NULL THEN
    RAISE EXCEPTION 'Recording derivative label cannot be removed' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER memory_recording_episode_label BEFORE UPDATE ON app.memory_episodes
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_derivative_label();
CREATE TRIGGER memory_recording_document_label BEFORE UPDATE ON app.memory_search_documents
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_derivative_label();

-- Deferred checks inspect the final row, so an atomic same-text side change can update
-- parent, association and derivatives in one transaction without transient label mismatches.
CREATE FUNCTION app.memory_recording_derivative_activation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE document app.memory_search_documents%ROWTYPE;
DECLARE episode app.memory_episodes%ROWTYPE;
DECLARE actual_revision BIGINT;
DECLARE managed_target BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'memory_search_documents' THEN
    SELECT * INTO document FROM app.memory_search_documents
    WHERE owner_user_id = NEW.owner_user_id AND id = NEW.id;
    IF NOT FOUND OR document.status <> 'active' THEN RETURN NULL; END IF;
    SELECT CASE WHEN document.target_kind = 'fact' THEN EXISTS (
      SELECT 1 FROM app.memory_recording_fact_versions
      WHERE owner_user_id = document.owner_user_id AND fact_id = document.target_id
    ) WHEN document.target_kind = 'episode' THEN EXISTS (
      SELECT 1 FROM app.memory_recording_receipts
      WHERE owner_user_id = document.owner_user_id AND episode_id = document.target_id
    ) ELSE false END INTO managed_target;
    IF NOT managed_target AND document.recording_side IS NULL THEN RETURN NULL; END IF;
    actual_revision := app.memory_recording_target_revision(
      document.owner_user_id,document.target_kind,document.target_id,document.recording_side);
    IF actual_revision IS NULL OR document.recording_revision IS DISTINCT FROM actual_revision THEN
      RAISE EXCEPTION 'Recording search activation is stale' USING ERRCODE = '23514';
    END IF;
  ELSIF TG_TABLE_NAME = 'memory_episodes' THEN
    SELECT * INTO episode FROM app.memory_episodes
    WHERE owner_user_id = NEW.owner_user_id AND id = NEW.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT EXISTS (SELECT 1 FROM app.memory_recording_receipts
      WHERE owner_user_id = episode.owner_user_id AND episode_id = episode.id) INTO managed_target;
    IF managed_target AND episode.recording_side IS NULL THEN
      RAISE EXCEPTION 'Recording episode label is missing' USING ERRCODE = '23514';
    END IF;
    IF episode.recording_side IS NOT NULL AND episode.recording_active
      AND app.memory_recording_target_revision(episode.owner_user_id,'episode',episode.id,episode.recording_side) IS NULL THEN
      RAISE EXCEPTION 'Recording episode activation is stale' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM app.memory_recording_receipts receipt
      WHERE receipt.owner_user_id = NEW.owner_user_id AND receipt.receipt_id = NEW.receipt_id
        AND receipt.state = 'applied'
        AND app.memory_recording_target_revision(receipt.owner_user_id,'episode',receipt.episode_id,receipt.side) IS NULL) THEN
      RAISE EXCEPTION 'Recording association is stale' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER memory_recording_document_activation AFTER INSERT OR UPDATE
  ON app.memory_search_documents DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_derivative_activation();
CREATE CONSTRAINT TRIGGER memory_recording_episode_activation AFTER INSERT OR UPDATE
  ON app.memory_episodes DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_derivative_activation();
CREATE CONSTRAINT TRIGGER memory_recording_receipt_activation AFTER INSERT OR UPDATE
  ON app.memory_recording_receipts DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_derivative_activation();

-- A correction temporarily links a new replacement before transferring its lineage.
-- Validate the committed association, so generic source reuse cannot strip its label.
CREATE FUNCTION app.memory_recording_provenance_label() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, app, pg_temp AS $$
DECLARE fact app.memory_facts%ROWTYPE;
DECLARE episode_side TEXT;
BEGIN
  SELECT * INTO fact FROM app.memory_facts
  WHERE owner_user_id = NEW.owner_user_id AND id = NEW.fact_id;
  IF NOT FOUND OR fact.status = 'superseded' THEN RETURN NULL; END IF;
  SELECT recording_side INTO episode_side FROM app.memory_episodes
  WHERE owner_user_id = NEW.owner_user_id AND id = NEW.episode_id;
  IF episode_side IS NULL AND NOT EXISTS (
    SELECT 1 FROM app.memory_recording_receipts
    WHERE owner_user_id = NEW.owner_user_id AND episode_id = NEW.episode_id
  ) THEN RETURN NULL; END IF;
  IF fact.recording_side IS DISTINCT FROM episode_side OR NOT EXISTS (
    SELECT 1 FROM app.memory_recording_fact_versions version
    JOIN app.memory_recording_receipts receipt
      ON receipt.owner_user_id = version.owner_user_id AND receipt.fact_id = version.fact_id
    WHERE version.owner_user_id = fact.owner_user_id AND version.fact_id = fact.id
      AND version.state = 'current' AND version.side = episode_side
      AND receipt.episode_id = NEW.episode_id AND receipt.side = episode_side
      AND receipt.state IN ('applied','undone')
  ) THEN
    RAISE EXCEPTION 'Recording provenance label is missing or incompatible' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER memory_recording_provenance_label AFTER INSERT OR UPDATE
  ON app.memory_fact_sources DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.memory_recording_provenance_label();
