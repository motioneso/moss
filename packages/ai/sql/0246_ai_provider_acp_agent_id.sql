ALTER TABLE app.ai_provider_configs
  ADD COLUMN acp_agent_id text;

-- Older routes allowed CLI auth for every provider kind, even though only Anthropic,
-- OpenAI-compatible, and Google had ACP identities. Backfill those known mappings; keep other
-- legacy rows, credentials, and models intact with a null identity so they can fail closed at chat
-- launch with remediation instead of making the upgrade fail. OpenCode had no provider row because
-- its old model preference lived separately in chat.settings.v1.
-- Like the execution-mode backfill in 0173, this one-time data update must run with RLS disabled
-- because the migration role is FORCE-RLS subject and does not have BYPASSRLS. Restore FORCE RLS
-- before the migration commits; runtime roles receive no bypass.
ALTER TABLE app.ai_provider_configs DISABLE ROW LEVEL SECURITY;

UPDATE app.ai_provider_configs
SET acp_agent_id = CASE provider_kind
  WHEN 'anthropic' THEN 'claude-acp'
  WHEN 'openai-compatible' THEN 'codex-acp'
  WHEN 'google' THEN 'antigravity-acp'
  ELSE NULL
END
WHERE auth_method = 'cli';

ALTER TABLE app.ai_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_provider_configs FORCE ROW LEVEL SECURITY;

ALTER TABLE app.ai_provider_configs
  ADD CONSTRAINT ai_provider_configs_auth_agent_identity
  CHECK (
    (auth_method = 'api_key' AND acp_agent_id IS NULL)
    OR (
      auth_method = 'cli'
      AND (
        (provider_kind IN ('anthropic', 'openai-compatible', 'google') AND acp_agent_id IS NOT NULL)
        OR (provider_kind NOT IN ('anthropic', 'openai-compatible', 'google') AND acp_agent_id IS NULL)
      )
    )
  );
