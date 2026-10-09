-- Deleting a replacement fact must not be blocked by the older facts it superseded.
-- The predecessors stay superseded; only their pointer to the deleted fact is cleared.
ALTER TABLE app.memory_facts
  DROP CONSTRAINT IF EXISTS memory_facts_superseded_by_owner_fk,
  ADD CONSTRAINT memory_facts_superseded_by_owner_fk
    FOREIGN KEY (owner_user_id, superseded_by_fact_id)
    REFERENCES app.memory_facts(owner_user_id, id)
    ON DELETE SET NULL (superseded_by_fact_id);
