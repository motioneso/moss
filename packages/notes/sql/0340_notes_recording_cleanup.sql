ALTER TABLE app.notes_recording_contributions ADD COLUMN cleanup_operation_id UUID;
ALTER TABLE app.notes_contribution_operations
  DROP CONSTRAINT notes_contribution_operations_state_check;
ALTER TABLE app.notes_contribution_operations
  ADD CONSTRAINT notes_contribution_operations_state_check
  CHECK (state IN ('pending','conflict','applied','cancelled'));
