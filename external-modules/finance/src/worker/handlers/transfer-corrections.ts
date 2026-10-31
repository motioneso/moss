import type { ToolFactory } from "../registry.js";
import { InputError, readBool } from "../validate.js";
import { currency, date, digest, today } from "./manual-ledger.js";
import { transferId, transferRevision, transferOutcome } from "./transfer-input.js";
export const transferReviewHandler: ToolFactory = (ports) => async (input) => {
  const originalTransferId = transferId(input, "originalTransferId");
  const store = await ports.store();
  return {
    status: "ok",
    today: today(ports),
    supported: Boolean(store.transferCorrections && store.transfers),
    receipt: store.transferCorrections
      ? await store.transferCorrections.read(originalTransferId)
      : null,
    accounts: store.transfers ? await store.transfers.accounts() : []
  };
};
export const transferReverseHandler: ToolFactory = (ports) => async (input) => {
  const operationId = transferId(input, "operationId"),
    originalTransferId = transferId(input, "originalTransferId"),
    sourceRevision = transferRevision(input, "sourceRevision"),
    fromRevision = transferRevision(input, "fromRevision"),
    toRevision = transferRevision(input, "toRevision");
  if (operationId === originalTransferId)
    throw new InputError("Choose a new correction operation identity");
  const current = today(ports),
    recordedDate = date(input, "date", current),
    cleared = readBool(input, "cleared") ?? false;
  const store = await ports.store();
  if (!store.transferCorrections)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before correcting linked transfers"
    );
  const original = await store.transferCorrections.read(originalTransferId);
  if (!original) throw new InputError("Review an owned saved manual transfer before correcting it");
  const payload = {
    operationId,
    originalTransferId,
    fromAccountId: original.toAccountId,
    toAccountId: original.fromAccountId,
    date: recordedDate,
    amountCents: original.amountCents,
    isoCurrency: currency({ isoCurrency: original.isoCurrency }),
    cleared
  };
  // The atomic store checks eligibility after replay lookup, so an already committed operation
  // can return unchanged even after reconciliation, closure or a recorded correction.
  return transferOutcome(
    await store.transferCorrections.reverse({
      ...payload,
      sourceRevision,
      fromRevision,
      toRevision,
      digest: digest(payload),
      today: current,
      at: ports.now().toISOString()
    }),
    operationId
  );
};
