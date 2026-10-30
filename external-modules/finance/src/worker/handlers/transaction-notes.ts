import type { NoteTarget } from "../../domain/transaction-notes.js";
import { validPrivateNote } from "../../domain/transaction-notes.js";
import { isCalendarMonth } from "../../domain/values.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
function target(input: Record<string, unknown>): NoteTarget {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("month must be a valid YYYY-MM");
  return {
    month,
    transactionId: readString(input, "transactionId", { required: true }),
    accountId: readString(input, "accountId", { required: true })
  };
}
export const transactionNoteReadHandler: ToolFactory = (ports) => async (input) => {
  const ids = target(input),
    store = await ports.store();
  if (!store.notes) return { available: false };
  const note = await store.notes.read(ids);
  return note ? { available: true, ...note } : { available: false };
};
export const transactionNoteSaveHandler: ToolFactory = (ports) => async (input) => {
  const ids = target(input),
    revision = readString(input, "writeRevision", { required: true }),
    notes = readString(input, "notes", { required: true, maxBytes: 4000 });
  if (!/^[a-f0-9]{32}$/.test(revision) || !validPrivateNote(notes))
    throw new InputError(
      "invalid_note",
      "Use a valid current review and a note of at most 4,000 UTF-8 bytes"
    );
  const store = await ports.store();
  if (!store.notes)
    throw new InputError("storage_upgrade_required", "Update Finance storage before editing notes");
  const outcome = await store.notes.save(ids, revision, notes, ports.now().toISOString());
  if (outcome === "stale")
    throw new InputError(
      "stale_transaction",
      "The saved transaction changed. Check the saved note before trying again."
    );
  return { status: "ok", outcome };
};
