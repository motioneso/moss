-- Migration 0214 — newest release wins inside a tier.
--
-- WHY: when a mode binding (economy / interactive / reasoning) has several models to choose from
-- in one tier, the router ordered them by the time the ROW was registered. A provider sync writes
-- every row in the same instant, so the tie fell to the random uuid and an older model (Sonnet 4.5)
-- beat a newer one (Sonnet 5). Provider model lists carry the model's own release date (Anthropic
-- `created_at`, OpenAI-compatible `created`); discovery now stores it here and the tier ladder
-- orders by it, newest first, nulls last. Manual rows and providers without a date keep NULL and
-- fall back to registration order as before.
-- Pure DDL, no data statement: safe under FORCE RLS + the NOBYPASSRLS migration role (0212 precedent).

ALTER TABLE app.ai_configured_models
  ADD COLUMN IF NOT EXISTS released_at timestamptz NULL;
