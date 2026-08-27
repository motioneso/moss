-- News publisher credentials (#2005, part of #950 credentialed publisher sources).
-- One row per (owner, custom source). encrypted_secret holds an AES-256-GCM
-- EncryptedSecret envelope (packages/db/src/secret-cipher.ts) produced by
-- NewsCredentialCipher in the composition root — never plaintext, and News itself
-- never resolves key material. Revoke is an UPDATE that scrubs the envelope
-- (encrypted_secret = NULL, status = 'revoked', revoked_at = now()), mirroring the
-- soft-revoke posture of app.module_credentials (0153) and app.connector_accounts.
--
-- There is no 'not_configured' row state: a source with no credential simply has no
-- row, and the API reports not_configured for that case.

CREATE TABLE IF NOT EXISTS app.news_source_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app.users (id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES app.news_custom_sources (id) ON DELETE CASCADE,
  -- Names the reviewed publisher connection that #2007 will define. This slice
  -- stores it verbatim and never interprets it.
  connection_id text NOT NULL CONSTRAINT news_source_credentials_connection_id_ck
    CHECK (char_length(connection_id) BETWEEN 1 AND 64),
  encrypted_secret jsonb CONSTRAINT news_source_credentials_envelope_ck
    CHECK (encrypted_secret IS NULL OR jsonb_typeof(encrypted_secret) = 'object'),
  status text NOT NULL CONSTRAINT news_source_credentials_status_ck
    CHECK (status IN ('configured', 'revoked')),
  -- Advanced by every successful rotation so #2007 can key its cache on it and a
  -- rotated-away key can never serve a cached response.
  generation bigint NOT NULL DEFAULT 1,
  last_validated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT news_source_credentials_owner_source_uq UNIQUE (owner_user_id, source_id),
  -- The two states cannot drift apart: a configured row always has an envelope and no
  -- revocation time; a revoked row always has neither.
  CONSTRAINT news_source_credentials_state_ck CHECK (
    (status = 'configured' AND encrypted_secret IS NOT NULL AND revoked_at IS NULL)
    OR (status = 'revoked' AND encrypted_secret IS NULL AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS news_source_credentials_source_idx
  ON app.news_source_credentials (source_id);

ALTER TABLE app.news_source_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.news_source_credentials FORCE ROW LEVEL SECURITY;

-- Owner-only, with no admin branch at all: admin power over News credentials is nil,
-- not read-only. No DELETE policy and no DELETE grant, because revoke is an UPDATE.
DROP POLICY IF EXISTS news_source_credentials_select ON app.news_source_credentials;
CREATE POLICY news_source_credentials_select ON app.news_source_credentials
  FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS news_source_credentials_insert ON app.news_source_credentials;
CREATE POLICY news_source_credentials_insert ON app.news_source_credentials
  FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id());

DROP POLICY IF EXISTS news_source_credentials_update ON app.news_source_credentials;
CREATE POLICY news_source_credentials_update ON app.news_source_credentials
  FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE ON app.news_source_credentials TO jarvis_app_runtime;
-- No jarvis_worker_runtime grant: this slice has no worker consumer. #2007 owns the
-- worker read path and adds the narrowest grant it needs in its own migration
-- (least privilege), the same way 0153 deferred to 0171.
