import { readReviewedRows } from "./reviewed-transactions.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readString } from "../validate.js";
import { loadCategories } from "./feed.js";
export const transactionsBulkCategoryHandler: ToolFactory = (ports) => async (input) => {
  const categoryId = readString(input, "categoryId", { required: true });
  const rows = readReviewedRows(input.rows);
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

export const transactionsConfirmHandler: ToolFactory = (ports) => async (input) => {
  const rows = readReviewedRows(input.rows);
  const store = await ports.store();
  if (!store.bulk?.confirm)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before confirming reviewed batches"
    );
  if (!(await store.bulk.confirm(rows)))
    throw new InputError(
      "stale_transactions",
      "A reviewed transaction or category changed. Nothing was confirmed; reload the register and review again."
    );
  return { status: "ok", confirmed: rows.length };
};
