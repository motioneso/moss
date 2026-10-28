import { isCalendarMonth, splitsBalance, type TransactionSplit } from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

/** Metadata-only queue. A split allocates an existing transaction; it cannot move bank money. */
export const splitApplyHandler: ToolFactory = (ports) => async (input) => {
  if (input.jobKind !== "finance.split-apply") throw new InputError("jobKind is not supported");
  if (!input.params || typeof input.params !== "object" || Array.isArray(input.params)) {
    throw new InputError("params must be an object");
  }
  const params = input.params as Record<string, unknown>;
  const transactionId = readString(params, "transactionId", { required: true });
  const accountId = readString(params, "accountId", { required: true });
  const month = readString(params, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("month must be a valid YYYY-MM");
  const expectedAmountCents = readInt(params, "expectedAmountCents", { required: true });
  const expectedRevision = readInt(params, "expectedRevision", { required: true, min: 0 });
  const ids = params.categoryIds;
  const amounts = params.amountsCents;
  if (
    !Array.isArray(ids) ||
    !Array.isArray(amounts) ||
    ids.length < 1 ||
    ids.length > 20 ||
    ids.length !== amounts.length
  ) {
    throw new InputError("categoryIds and amountsCents must list 1 to 20 equal-length entries");
  }
  const live = new Set(
    (await loadCategories(ports))
      .filter((c) => !c.archived && c.id !== "transfers")
      .map((c) => c.id)
  );
  const splits: TransactionSplit[] = ids.map((categoryId, index) => {
    if (typeof categoryId !== "string" || !live.has(categoryId)) {
      throw new InputError(
        "invalid_category",
        "Choose a live non-transfer category for every part"
      );
    }
    const amountCents = readInt({ amountCents: amounts[index] }, "amountCents", {
      required: true,
      min: -100_000_000,
      max: 100_000_000
    });
    return { categoryId, amountCents };
  });
  if (!splitsBalance({ amountCents: expectedAmountCents, splits })) {
    throw new InputError("split_total_mismatch", "Split amounts must equal the transaction total");
  }
  const store = await ports.store();
  if (!store.supportsSplits)
    throw new InputError(
      "storage_upgrade_required",
      "Complete Finance storage migration before editing splits"
    );
  const row = (await store.getTransactionChunk(accountId, month))?.find(
    (r) => r.id === transactionId
  );
  if (!row) throw new InputError("not_found", "Transaction is unavailable");
  if (row.pending)
    throw new InputError(
      "pending_transaction",
      "Wait until the transaction posts before splitting it"
    );
  if (row.amountCents !== expectedAmountCents)
    throw new InputError(
      "stale_transaction",
      "The transaction amount changed; reload before saving"
    );
  const actual = row.splits?.length
    ? row.splits
    : [{ categoryId: row.categoryId, amountCents: row.amountCents }];
  // Retrying a completed queue job is harmless, even after its revision advanced.
  if (JSON.stringify(actual) === JSON.stringify(splits)) return { status: "ok", unchanged: true };
  if (
    (row.splitRevision ?? 0) !== expectedRevision ||
    !(await store.setTransactionSplits({
      transactionId,
      accountId,
      month,
      expectedAmountCents,
      expectedRevision,
      splits
    }))
  ) {
    throw new InputError("stale_transaction", "The transaction changed; reload before saving");
  }
  return { status: "ok", parts: splits.length };
};
