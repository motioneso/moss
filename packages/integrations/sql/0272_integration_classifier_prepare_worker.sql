-- #2984 classifier tools on by default, R2.4: the background preparation job saves its results.
--
-- The worker role could write only the sort column. It now also gets UPDATE on the preparation
-- column. The owner-scoped worker update policy from 0270 still applies, so a job enters its
-- owner's data context and can touch only that owner's rows. No role bypasses RLS.
GRANT UPDATE (classifier_preparation) ON app.integration_connections TO jarvis_worker_runtime;
