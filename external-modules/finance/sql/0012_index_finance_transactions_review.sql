-- #3175 (Finance R1): serves the "Needs a look" count and filter.
CREATE INDEX finance_transactions_needs_look
  ON app.finance_transactions (owner_user_id, date DESC)
  WHERE review_state = 'needs_look'
