-- #2638 Backtrack phase 2a, memory-owned slice (spec 2026-09-23-trail-marker-screen-history.md
-- §6, plan 2026-10-03-backtrack-phase2.md §4.1). Widen memory_chunks' source-kind CHECK to admit
-- 'screen', the kind the backtrack module's index job writes embeddings under
-- (sourcePath "backtrack/<segment id>"). Backtrack never queries app.memory_chunks directly; it
-- goes through MemoryRepository.deleteChunksForSources, this module's own public API.
--
-- Recall never reads this kind by accident: every chunk search names one source kind
-- (repository.ts), and the retriever defaults to "vault" (retrieval.ts). So a 'screen' chunk is
-- reachable only by a caller that asks for it by name, which is Phase 3's search tool, not yet
-- built.
--
-- memory_file_index is left alone on purpose: unlike vault/notes (a file re-ingested in place,
-- tracked by content hash) or chat (one thread, tracked the same way), a screen segment has no
-- file to track — its "already indexed" state lives on backtrack_segments.indexed_at, not here.
-- Nothing ever writes a memory_file_index row with source_kind = 'screen'.
ALTER TABLE app.memory_chunks DROP CONSTRAINT IF EXISTS memory_chunks_source_kind_check;
ALTER TABLE app.memory_chunks
  ADD CONSTRAINT memory_chunks_source_kind_check
  CHECK (source_kind IN ('vault', 'connector', 'chat', 'notes', 'screen'));
