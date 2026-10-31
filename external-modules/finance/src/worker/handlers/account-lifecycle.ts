import type { ToolFactory } from "../registry.js";
import { InputError, readEnum, readString } from "../validate.js";
import { today } from "./manual-ledger.js";
function accountId(input: Record<string, unknown>) {
  const id = readString(input, "accountId", { required: true });
  if (!id || id.length > 256) throw new InputError("Choose an owned manual account");
  return id;
}
export const accountReviewHandler: ToolFactory = (ports) => async (input) => {
  const id = accountId(input),
    current = today(ports),
    store = await ports.store();
  if (!store.accountLifecycle) return { status: "storage_update_required" };
  const account = await store.accountLifecycle.review(id, current);
  return account
    ? { status: "ok", today: current, account }
    : { status: "unavailable", today: current };
};
export const accountUpdateHandler: ToolFactory = (ports) => async (input) => {
  const id = accountId(input),
    operation = readEnum(input, "operation", ["rename", "close", "reopen"] as const);
  const expectedRevision = readString(input, "expectedRevision", { required: true });
  if (!operation || !/^[a-f0-9]{32}$/.test(expectedRevision))
    throw new InputError("Review the saved manual account first");
  const raw = readString(input, "name", { maxBytes: 320 }),
    name = raw?.trim();
  if (operation === "rename" && (!name || name.length > 80))
    throw new InputError("Choose a name between 1 and 80 characters");
  if (operation !== "rename" && raw !== undefined)
    throw new InputError("A name is accepted only when renaming an account");
  const store = await ports.store();
  if (!store.accountLifecycle)
    throw new InputError(
      "storage_upgrade_required",
      "Update Finance storage before managing manual accounts"
    );
  if (
    !(await store.accountLifecycle.update({
      accountId: id,
      operation,
      expectedRevision,
      name,
      today: today(ports),
      at: ports.now().toISOString()
    }))
  )
    throw new InputError(
      "account_changed",
      "The account or its dependencies changed. No account update was saved; review its saved state again."
    );
  return { status: "ok", operation };
};
