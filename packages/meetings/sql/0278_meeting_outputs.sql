-- Generated snapshots and mutation receipts inherit owner-only meeting scope.
CREATE TABLE app.meeting_output_requests (
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  request_key UUID NOT NULL,
  input_json TEXT NOT NULL CHECK (octet_length(input_json) <= 524288),
  expires_at TIMESTAMPTZ(3) NOT NULL DEFAULT (clock_timestamp() + interval '2 minutes'),
  result_json TEXT CHECK (octet_length(result_json) <= 1048576),
  PRIMARY KEY (meeting_id, request_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE
);
CREATE TABLE app.meeting_output_artifacts (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  version INTEGER NOT NULL CHECK (version > 0),
  artifact_json TEXT NOT NULL CHECK (octet_length(artifact_json) <= 1048576),
  inactive BOOLEAN NOT NULL,
  created_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (meeting_id, version),
  UNIQUE (id),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE
);
CREATE TABLE app.meeting_action_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID NOT NULL,
  owner_user_id UUID NOT NULL DEFAULT app.current_actor_user_id(),
  identity_key TEXT NOT NULL,
  artifact_version INTEGER NOT NULL,
  proposal_json TEXT NOT NULL CHECK (octet_length(proposal_json) <= 64000),
  possible_match_ids JSONB NOT NULL DEFAULT '[]',
  review_state TEXT NOT NULL DEFAULT 'pending' CHECK (review_state IN ('pending', 'accepted', 'dismissed')),
  accepted_task_id UUID,
  UNIQUE (meeting_id, identity_key),
  FOREIGN KEY (meeting_id, owner_user_id) REFERENCES app.meeting_records(id, owner_user_id) ON DELETE CASCADE,
  FOREIGN KEY (meeting_id, artifact_version) REFERENCES app.meeting_output_artifacts(meeting_id, version) ON DELETE CASCADE,
  CHECK ((review_state = 'accepted') = (accepted_task_id IS NOT NULL))
);
-- No foreign key to Tasks: copied Tasks have a separate lifecycle and module owns its tables.
ALTER TABLE app.meeting_output_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_output_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_output_requests_owner ON app.meeting_output_requests FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id());
ALTER TABLE app.meeting_output_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_output_artifacts FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_output_artifacts_owner ON app.meeting_output_artifacts FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id());
ALTER TABLE app.meeting_action_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.meeting_action_candidates FORCE ROW LEVEL SECURITY;
CREATE POLICY meeting_action_candidates_owner ON app.meeting_action_candidates FOR ALL TO jarvis_app_runtime USING (owner_user_id = app.current_actor_user_id()) WITH CHECK (owner_user_id = app.current_actor_user_id());
GRANT SELECT, INSERT ON app.meeting_output_requests, app.meeting_output_artifacts, app.meeting_action_candidates TO jarvis_app_runtime;
GRANT UPDATE (result_json) ON app.meeting_output_requests TO jarvis_app_runtime;
GRANT UPDATE (review_state, accepted_task_id) ON app.meeting_action_candidates TO jarvis_app_runtime;
