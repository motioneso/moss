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
  if (!store.bulk?.confirmWithUndo)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before confirming reviewed batches"
    );
  const undo = await store.bulk.confirmWithUndo(rows);
  if (!undo)
    throw new InputError(
      "stale_transactions",
      "A reviewed transaction or category changed. Nothing was confirmed; reload the register and review again."
    );
  return { status: "ok", confirmed: rows.length, undo: { rows: undo } };
};

const SOURCES = ["rule", "plaid-map", "ai", "user"] as const;

export const transactionsUnconfirmHandler: ToolFactory = (ports) => async (input) => {
  const raw = Array.isArray(input.rows) ? (input.rows as unknown[]) : [];
  const rows = readReviewedRows(raw).map((row, i) => {
    const by = (raw[i] as { categorizedBy?: unknown }).categorizedBy ?? null;
    if (by !== null && !SOURCES.includes(by as (typeof SOURCES)[number]))
      throw new InputError("Review each transaction before saving");
    return { ...row, categorizedBy: by as (typeof SOURCES)[number] | null };
  });
  const store = await ports.store();
  if (!store.bulk?.unconfirm)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before undoing a confirm"
    );
  if (!(await store.bulk.unconfirm(rows)))
    throw new InputError(
      "stale_transactions",
      "A transaction changed after it was confirmed. Nothing was undone."
    );
  return { status: "ok", unconfirmed: rows.length };
};
