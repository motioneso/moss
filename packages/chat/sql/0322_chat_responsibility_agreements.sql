-- #3142a: agreement records are inert. No reminder foreign key, job or worker write grant.
CREATE TABLE app.chat_responsibility_proposals (
  id uuid PRIMARY KEY,
  owner_user_id uuid NOT NULL REFERENCES app.users(id) ON DELETE CASCADE,
  thread_id uuid NOT NULL REFERENCES app.chat_threads(id) ON DELETE CASCADE,
  proposal_kind text NOT NULL CHECK (length(proposal_kind) BETWEEN 1 AND 100),
  proposal_version integer NOT NULL CHECK (proposal_version >= 1),
  terms_json jsonb NOT NULL CHECK (jsonb_typeof(terms_json) = 'object' AND octet_length(terms_json::text) <= 16000),
  terms_fingerprint text NOT NULL CHECK (terms_fingerprint ~ '^[a-f0-9]{64}$'),
  valid_until timestamptz,
  question_user_message_id uuid NOT NULL REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  question_assistant_message_id uuid NOT NULL REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending', 'cancelled', 'accepted')),
  acceptance_message_id uuid REFERENCES app.chat_messages(id) ON DELETE CASCADE,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (proposal_kind <> 'bounded_action_creation' OR (valid_until IS NOT NULL AND valid_until = (terms_json->>'dueAt')::timestamptz)),
  CHECK ((state = 'accepted') = (acceptance_message_id IS NOT NULL AND accepted_at IS NOT NULL))
);
CREATE UNIQUE INDEX chat_responsibility_pending_thread ON app.chat_responsibility_proposals(thread_id) WHERE state = 'pending';
ALTER TABLE app.chat_responsibility_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_responsibility_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY responsibility_proposal_read ON app.chat_responsibility_proposals FOR SELECT TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id());
CREATE POLICY responsibility_proposal_insert ON app.chat_responsibility_proposals FOR INSERT TO jarvis_app_runtime
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND state = 'pending' AND acceptance_message_id IS NULL AND EXISTS (
    SELECT 1 FROM app.chat_threads t WHERE t.id = thread_id AND t.owner_user_id = app.current_actor_user_id()
      AND NOT t.incognito AND t.surface = 'drawer'
  ) AND EXISTS (
    SELECT 1 FROM app.chat_messages u JOIN app.chat_messages q
      ON q.thread_id = u.thread_id AND q.owner_user_id = u.owner_user_id
      AND q.created_at = u.created_at AND q.tool_metadata->>'turnId' = u.tool_metadata->>'turnId'
    WHERE u.id = question_user_message_id AND q.id = question_assistant_message_id
      AND u.thread_id = chat_responsibility_proposals.thread_id AND u.owner_user_id = app.current_actor_user_id()
      AND u.role = 'user' AND q.role = 'assistant' AND u.status = 'stored' AND q.status = 'stored'
      AND q.model_metadata->'origin'->'responsibilityProposal'->>'id' = chat_responsibility_proposals.id::text
      AND q.model_metadata->'origin'->'responsibilityProposal'->>'kind' = proposal_kind
      AND q.model_metadata->'origin'->'responsibilityProposal'->>'version' = proposal_version::text
      AND q.model_metadata->'origin'->'responsibilityProposal'->>'fingerprint' = terms_fingerprint
  ));
CREATE POLICY responsibility_proposal_update ON app.chat_responsibility_proposals FOR UPDATE TO jarvis_app_runtime
  USING (owner_user_id = app.current_actor_user_id() AND state = 'pending')
  WITH CHECK (owner_user_id = app.current_actor_user_id() AND state IN ('cancelled', 'accepted') AND
    (state = 'cancelled' OR ((valid_until IS NULL OR valid_until > clock_timestamp()) AND EXISTS (SELECT 1 FROM app.chat_messages m WHERE m.id = acceptance_message_id
      AND m.thread_id = chat_responsibility_proposals.thread_id AND m.owner_user_id = app.current_actor_user_id()
      AND m.role = 'user' AND m.status = 'stored' AND lower(m.body) ~ E'^[ \t\r\n]*yes[.!]?[ \t\r\n]*$'
      AND jsonb_array_length(coalesce(m.tool_metadata->'attachments', '[]'::jsonb)) = 0
      AND EXISTS (SELECT 1 FROM app.chat_messages q WHERE q.id = question_assistant_message_id
        AND m.created_at >= q.created_at AND m.tool_metadata->>'turnId' <> q.tool_metadata->>'turnId'
        AND NOT EXISTS (SELECT 1 FROM app.chat_messages newer WHERE newer.thread_id = m.thread_id
          AND newer.owner_user_id = m.owner_user_id AND newer.role = 'user' AND newer.status = 'stored'
          AND newer.tool_metadata->>'turnId' <> m.tool_metadata->>'turnId' AND newer.created_at > q.created_at))))));
GRANT SELECT, INSERT ON app.chat_responsibility_proposals TO jarvis_app_runtime;
GRANT UPDATE(state, acceptance_message_id, accepted_at) ON app.chat_responsibility_proposals TO jarvis_app_runtime;
