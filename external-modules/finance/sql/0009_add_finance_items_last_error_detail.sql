-- #3161: Plaid's full error (type, code, message, request id) as JSON text, so
-- a failed sync can be diagnosed later. Never holds tokens or account numbers.
ALTER TABLE app.finance_items ADD COLUMN last_error_detail text
