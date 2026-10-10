-- #3180 (Finance R1): the first-budget draft. One row per draft built from the
-- bank history; lines live in finance_budget_draft_lines. status moves only
-- open -> started (or discarded). Numbers come from the record, never from chat.
CREATE TABLE app.finance_budget_drafts (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'started', 'discarded')),
  basis_from date NOT NULL,
  basis_to date NOT NULL,
  monthly_income_cents bigint NOT NULL,
  created_at timestamptz NOT NULL,
  started_at timestamptz,
  PRIMARY KEY (owner_user_id, id)
)
