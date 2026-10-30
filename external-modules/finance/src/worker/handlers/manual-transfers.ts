import type { ToolFactory } from "../registry.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { currency, date, digest, today } from "./manual-ledger.js";
export const transferContextHandler: ToolFactory = (ports) => async () => {
  const store = await ports.store();
  return {
    status: "ok",
    today: today(ports),
    supported: Boolean(store.transfers),
    accounts: store.transfers ? await store.transfers.accounts() : []
  };
};
export const transferCreateHandler: ToolFactory = (ports) => async (input) => {
  const operationId = readString(input, "operationId", { required: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId))
    throw new InputError("Choose a new transfer operation identity");
  const fromAccountId = readString(input, "fromAccountId", { required: true }),
    toAccountId = readString(input, "toAccountId", { required: true });
  if (
    !fromAccountId ||
    !toAccountId ||
    fromAccountId.length > 256 ||
    toAccountId.length > 256 ||
    fromAccountId === toAccountId
  )
    throw new InputError("Choose two different owned manual accounts");
  const fromRevision = readString(input, "fromRevision", { required: true }),
    toRevision = readString(input, "toRevision", { required: true });
  if (!/^[a-f0-9]{32}$/.test(fromRevision) || !/^[a-f0-9]{32}$/.test(toRevision))
    throw new InputError("Review both saved accounts before recording a transfer");
  const current = today(ports),
    recordedDate = date(input, "date", current),
    isoCurrency = currency(input),
    amountCents = readInt(input, "amountCents", { required: true }),
    cleared = readBool(input, "cleared") ?? false;
  if (amountCents < 1) throw new InputError("Enter a positive transfer amount in exact cents");
  const store = await ports.store();
  if (!store.transfers)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before recording linked transfers"
    );
  const payload = {
    operationId,
    fromAccountId,
    toAccountId,
    date: recordedDate,
    amountCents,
    isoCurrency,
    cleared
  };
  const result = await store.transfers.create({
    ...payload,
    fromRevision,
    toRevision,
    digest: digest(payload),
    today: current,
    at: ports.now().toISOString()
  });
  if (result === "changed")
    throw new InputError(
      "transfer_changed",
      "One of these ledgers changed or no longer accepts this movement. No transfer was recorded; review both saved accounts."
    );
  if (result === "conflict")
    throw new InputError(
      "transfer_conflict",
      "This operation identity belongs to different saved details. Check account history before starting a new transfer."
    );
  return { status: "ok", transferId: operationId, unchanged: result === "unchanged" };
};
