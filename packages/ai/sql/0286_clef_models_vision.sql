-- #3067: Clef reads a picture beside its questions, so discovery now gives Clef rows `vision`.
-- Refreshing models never adds a capability to a row that already exists (only `web-search`),
-- so rows created since #3057 would stay `json` only. This one-time backfill adds `vision` to
-- those rows: the fixed Clef ids on a decision-model provider whose address is Cloudflare's.
--
-- The migration runner is NOBYPASSRLS and both tables FORCE row security, so RLS is dropped
-- for the backfill and restored in the same transaction (the 0173 idiom).

ALTER TABLE app.ai_provider_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models DISABLE ROW LEVEL SECURITY;

UPDATE app.ai_configured_models m
SET capabilities = array_append(m.capabilities, 'vision'),
    updated_at = now()
FROM app.ai_provider_configs p
WHERE p.id = m.provider_config_id
  AND p.provider_kind = 'system-one'
  AND p.base_url ~ '^https://api\.cloudflare\.com(/|$)'
  AND m.provider_model_id IN ('clef', 'clef-flash')
  AND NOT ('vision' = ANY(m.capabilities));

ALTER TABLE app.ai_provider_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_provider_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_configured_models FORCE ROW LEVEL SECURITY;
