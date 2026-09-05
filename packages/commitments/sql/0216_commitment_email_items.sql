-- Spec 2026-09-04-email-chief-of-staff: one candidate per email thread, with proposed actions,
-- plus a per-thread record of the last judgement so a thread is not judged twice for nothing.
ALTER TABLE app.commitment_candidates
  ADD COLUMN counterparty_person_id   uuid,
  ADD COLUMN counterparty_address     text CHECK (char_length(counterparty_address) <= 320),
  ADD COLUMN proposed_actions         jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(proposed_actions) = 'array'),
  ADD COLUMN why_lines                text[] NOT NULL DEFAULT '{}' CHECK (cardinality(why_lines) <= 3),
  ADD COLUMN thread_ref               text CHECK (char_length(thread_ref) <= 256),
  ADD COLUMN last_judged_external_id  text CHECK (char_length(last_judged_external_id) <= 256),
  ADD COLUMN stale                    boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_commitment_candidates_owner_thread
  ON app.commitment_candidates (owner_user_id, thread_ref) WHERE thread_ref IS NOT NULL;

CREATE TABLE app.commitment_email_thread_judgements (
  owner_user_id            uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  thread_ref               text NOT NULL CHECK (char_length(thread_ref) <= 256),
  last_judged_external_id  text NOT NULL CHECK (char_length(last_judged_external_id) <= 256),
  outcome                  text NOT NULL CHECK (outcome IN ('no_item', 'item')),
  judged_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_user_id, thread_ref)
);

ALTER TABLE app.commitment_email_thread_judgements FORCE ROW LEVEL SECURITY;
ALTER TABLE app.commitment_email_thread_judgements ENABLE ROW LEVEL SECURITY;

-- Owner-only for both runtime roles: the worker runs each judgement inside the actor's data
-- context, so it reads and writes only that person's rows.
CREATE POLICY commitment_email_thread_judgements_owner ON app.commitment_email_thread_judgements
  AS PERMISSIVE
  FOR ALL
  TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.commitment_email_thread_judgements TO jarvis_app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.commitment_email_thread_judgements TO jarvis_worker_runtime;
