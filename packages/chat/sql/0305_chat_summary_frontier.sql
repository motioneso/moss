-- A conversation summary counts only with a covered frontier and a revision.
-- Revision 0 with no frontier marks a legacy rolling summary, which replay ignores.
-- The frontier is a plain id rather than a foreign key: thread deletion cascades
-- through chat_messages, and a back-reference would update the row being deleted.
ALTER TABLE app.chat_threads
  ADD COLUMN IF NOT EXISTS summary_covered_through_message_id uuid;

ALTER TABLE app.chat_threads
  ADD COLUMN IF NOT EXISTS summary_revision integer NOT NULL DEFAULT 0;
