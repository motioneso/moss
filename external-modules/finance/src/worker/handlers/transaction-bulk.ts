import type { ReviewedTransaction } from "../../domain/transaction-bulk.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
import { loadCategories } from "./feed.js";
export const transactionsBulkCategoryHandler: ToolFactory = (ports) => async (input) => {
  const categoryId = readString(input, "categoryId", { required: true });
  const raw = input.rows;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200)
    throw new InputError("Choose between 1 and 200 loaded transactions");
  const rows: ReviewedTransaction[] = raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new InputError("Review each transaction before saving");
    const id = readString(value, "id", { required: true });
    const writeRevision = readString(value, "writeRevision", { required: true });
    if (id.length > 256 || !/^[a-f0-9]{32}$/.test(writeRevision))
      throw new InputError("Review each transaction before saving");
    return { id, writeRevision };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new InputError("Choose each transaction only once");
  if (
    !(await loadCategories(ports)).some(
      (c) => c.id === categoryId && !c.archived && c.id !== "transfers"
    )
  )
    throw new InputError("invalid_category", "Choose a live non-transfer category");
  const store = await ports.store();
  if (!store.bulk)
    throw new InputError("storage_upgrade_required", "Update Finance storage before bulk editing");
  if (!(await store.bulk.categorize(rows, categoryId)))
    throw new InputError(
      "stale_transactions",
      "A selected transaction or category changed. Nothing was saved; reload and review your selection."
    );
  return { status: "ok", updated: rows.length };
};
