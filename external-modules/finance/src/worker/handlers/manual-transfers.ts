import { transferId, transferRevision, transferOutcome } from "./transfer-input.js";
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
  const operationId = transferId(input, "operationId");
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
  const fromRevision = transferRevision(input, "fromRevision"),
    toRevision = transferRevision(input, "toRevision");
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
  return transferOutcome(result, operationId);
};
