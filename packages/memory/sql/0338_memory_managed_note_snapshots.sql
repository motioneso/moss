-- Side and full source generations accompany both partial chunks and completed index entries.
ALTER TABLE app.memory_chunks ADD COLUMN managed_snapshot JSONB
  CHECK (managed_snapshot IS NULL OR (jsonb_typeof(managed_snapshot)='object'
    AND managed_snapshot ? 'side'
    AND (managed_snapshot->>'side' IN ('personal','work') OR managed_snapshot->'side'='null'::jsonb)));
ALTER TABLE app.memory_file_index ADD COLUMN managed_snapshot JSONB
  CHECK (managed_snapshot IS NULL OR (jsonb_typeof(managed_snapshot)='object'
    AND managed_snapshot ? 'side'
    AND (managed_snapshot->>'side' IN ('personal','work') OR managed_snapshot->'side'='null'::jsonb)));
CREATE INDEX memory_chunks_managed_destination ON app.memory_chunks(owner_user_id,(managed_snapshot->>'destinationId')) WHERE managed_snapshot IS NOT NULL;
CREATE INDEX memory_file_index_managed_destination ON app.memory_file_index(owner_user_id,(managed_snapshot->>'destinationId')) WHERE managed_snapshot IS NOT NULL;
