-- Migration 0312: durable once-per-finding accounting for unsolicited email alerts (#3146).
-- One row per (owner, finding stable key), written in the scan transaction that first selects
-- the finding. The email daily and hourly caps count these rows, so dismissal does not refill
-- the budget and retries or later scans of the same finding never charge again.
-- Owner-scoped, FORCE RLS, no admin bypass.

CREATE TABLE app.proactive_email_finding_charges (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  stable_key    text NOT NULL,
  charged_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, stable_key)
);

CREATE INDEX proactive_email_finding_charges_owner_charged
  ON app.proactive_email_finding_charges (owner_user_id, charged_at);

-- Carry existing email findings forward so a migrated finding keeps its identity and is never
-- charged or surfaced again; charged_at is its earliest card's creation time. Migrations run as
-- a NOBYPASSRLS owner, so FORCE on proactive_cards is lifted for the read, and the backfill runs
-- before FORCE applies to the new table.
ALTER TABLE app.proactive_cards NO FORCE ROW LEVEL SECURITY;

INSERT INTO app.proactive_email_finding_charges (owner_user_id, stable_key, charged_at)
SELECT owner_user_id, stable_key, min(created_at)
FROM app.proactive_cards
WHERE source = 'email'
GROUP BY owner_user_id, stable_key
ON CONFLICT (owner_user_id, stable_key) DO NOTHING;

ALTER TABLE app.proactive_cards FORCE ROW LEVEL SECURITY;

ALTER TABLE app.proactive_email_finding_charges ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.proactive_email_finding_charges FORCE ROW LEVEL SECURITY;

CREATE POLICY proactive_email_finding_charges_owner ON app.proactive_email_finding_charges
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

-- Only the scanner (worker) charges findings. Charges are append-only.
GRANT SELECT, INSERT ON app.proactive_email_finding_charges TO jarvis_worker_runtime;
