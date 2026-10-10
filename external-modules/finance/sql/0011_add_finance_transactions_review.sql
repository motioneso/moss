-- #3175 (Finance R1): review state and AI confidence on transactions. Existing
-- rows default to 'confirmed', so the upgrade creates no review backlog.
-- ai_confidence is set only when the AI step chose the category (0 to 1).
ALTER TABLE app.finance_transactions
  ADD COLUMN review_state text NOT NULL DEFAULT 'confirmed'
    CHECK (review_state IN ('confirmed', 'needs_look')),
  ADD COLUMN ai_confidence real
    CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1))
