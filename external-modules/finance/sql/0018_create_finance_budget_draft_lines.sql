-- #3180 (Finance R1): one planned line per category in a draft. proposed_cents
-- is the history average rounded up to the next $5; adjusted_cents holds a
-- later change (adjusted_by says who made it); dropped removes the line.
CREATE TABLE app.finance_budget_draft_lines (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  draft_id uuid NOT NULL,
  category_key text NOT NULL,
  group_name text NOT NULL,
  category_name text NOT NULL,
  basis_monthly_cents bigint NOT NULL,
  proposed_cents bigint NOT NULL,
  adjusted_cents bigint,
  adjusted_by text CHECK (adjusted_by IN ('user', 'moss')),
  dropped boolean NOT NULL DEFAULT false,
  PRIMARY KEY (owner_user_id, draft_id, category_key),
  FOREIGN KEY (owner_user_id, draft_id)
    REFERENCES app.finance_budget_drafts (owner_user_id, id) ON DELETE CASCADE
)
