-- Review fix (#3160): rows with no category were stored as 'confirmed' by the 0011 column
-- default, so they never reached Needs a look. Flag them. Placed rows are untouched.
UPDATE app.finance_transactions
SET review_state = 'needs_look'
WHERE category_id IS NULL AND review_state = 'confirmed'
