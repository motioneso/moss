-- Migration 0212 — #2208: discovered vs manual model rows.
--
-- WHY: CLI-provider discovery (the runner asks the vendor for its live model list) reconciles a
-- provider's rows against that list. Before this column every concrete row looked the same, so a
-- refresh or re-login wiped rows an admin had added by hand. `origin` marks who created a row:
--   'discovered' — written by discovery; may be pruned when the vendor's list no longer has it.
--   'manual'     — written through POST /api/ai/models; never pruned by discovery.
-- Every existing row was created by discovery or the legacy static lists, so the column default
-- backfills them to 'discovered'. Pure DDL: no data statement runs here, which keeps it safe under
-- FORCE RLS + the NOBYPASSRLS migration role (same precedent as 0147/0150).
-- No RLS/policy/trigger changes: existing owner/admin policies cover the new column.

ALTER TABLE app.ai_configured_models
  ADD COLUMN IF NOT EXISTS origin text NOT NULL DEFAULT 'discovered'
  CHECK (origin IN ('discovered', 'manual'));
