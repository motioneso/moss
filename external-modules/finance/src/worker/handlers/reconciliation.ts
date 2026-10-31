import { MAX_RECONCILE_ENTRIES } from "../../domain/reconciliation.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readInt, readString } from "../validate.js";
import { currency, date, digest, id, today } from "./manual-ledger.js";

export const reconciliationReadHandler: ToolFactory = (ports) => async (input) => {
  const currentDate = today(ports);
  const statementDate =
    input.statementDate === undefined ? currentDate : date(input, "statementDate", currentDate);
  const accountId = readString(input, "accountId", { required: true, maxBytes: 128 });
  const store = (await ports.store()).reconciliation;
  if (!store) throw new InputError("storage_upgrade_required", "Finance storage needs an update");
  const view = await store.read(accountId, statementDate);
  if (!view) throw new InputError("manual_unavailable", "Manual account is unavailable");
  return { status: "ok", today: currentDate, statementDate, view };
};

export const reconciliationFinishHandler: ToolFactory = (ports) => async (input) => {
  const store = (await ports.store()).reconciliation;
  if (!store) throw new InputError("storage_upgrade_required", "Finance storage needs an update");
  const selectedIds = input.selectedIds;
  if (
    !Array.isArray(selectedIds) ||
    selectedIds.length > MAX_RECONCILE_ENTRIES ||
    selectedIds.some(
      (value) => typeof value !== "string" || value.length === 0 || value.length > 128
    ) ||
    new Set(selectedIds).size !== selectedIds.length
  )
    throw new InputError("selectedIds must be distinct transaction identities");
  const values = {
    id: id(input, "operationId"),
    accountId: readString(input, "accountId", { required: true, maxBytes: 128 }),
    statementDate: date(input, "statementDate", today(ports)),
    balanceCents: readInt(input, "balanceCents", { required: true }),
    isoCurrency: currency(input),
    expectedRevision: readInt(input, "expectedRevision", { required: true, min: 0 }),
    selectedIds: [...(selectedIds as string[])].sort()
  };
  const result = await store.finish({
    ...values,
    digest: digest(values),
    at: ports.now().toISOString()
  });
  if (result === "conflict")
    throw new InputError(
      "stale_reconciliation",
      "The statement does not match the current ledger; refresh and review before finishing"
    );
  return { status: "ok", id: values.id, unchanged: result === "unchanged" };
};
