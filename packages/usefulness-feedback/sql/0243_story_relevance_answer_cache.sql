-- #2636: remember the sorting model's yes/no answer for each (story, saved rule, sorting model)
-- pair, so a refresh does not ask the same question again.
--
-- Owner-only under RLS, no BYPASSRLS. The cached row holds only the verdict and the confidence.
-- No prompt, story text, headline, term or reason is stored here. The story reference is the same
-- opaque hash the matcher already uses, and the rule and model are keyed by hashes so that an
-- edited rule or a switched model stops matching without reading the old answer.
--
-- The transaction that writes an answer is the same one the matcher already runs in, so a rule
-- edit (repository.updateReason) and a rule retirement (repository.undo/supersede) delete that
-- rule's rows in the same scoped statement.

CREATE TABLE IF NOT EXISTS app.story_relevance_answer_cache (
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  story_ref text NOT NULL CHECK (length(story_ref) BETWEEN 1 AND 120),
  rule_id uuid NOT NULL,
  rule_text_hash text NOT NULL CHECK (length(rule_text_hash) = 64),
  model_fingerprint text NOT NULL CHECK (length(model_fingerprint) = 64),
  answer text NOT NULL CHECK (answer IN ('yes', 'no')),
  confidence double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (owner_user_id, story_ref, rule_id, rule_text_hash, model_fingerprint)
);

-- Deleting a rule's answers is owner and rule scoped; the primary key leads with owner then story,
-- so this index serves the delete without a scan.
CREATE INDEX IF NOT EXISTS story_relevance_answer_cache_owner_rule_idx
  ON app.story_relevance_answer_cache (owner_user_id, rule_id);

ALTER TABLE app.story_relevance_answer_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.story_relevance_answer_cache FORCE ROW LEVEL SECURITY;

CREATE POLICY story_relevance_answer_cache_owner ON app.story_relevance_answer_cache
  FOR ALL TO jarvis_app_runtime, jarvis_worker_runtime
  USING (owner_user_id = app.current_actor_user_id())
  WITH CHECK (owner_user_id = app.current_actor_user_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON app.story_relevance_answer_cache
  TO jarvis_app_runtime, jarvis_worker_runtime;
