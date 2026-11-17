CREATE UNIQUE INDEX memory_reembed_one_running
  ON app.memory_reembed_runs (owner_user_id) WHERE status = 'running';
