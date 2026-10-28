import { createHash } from "node:crypto";
import {
  isCalendarDate,
  MANUAL_ACCOUNT_TYPES,
  MANUAL_CURRENCIES,
  manualAccountKind,
  type ManualAccountType,
  type ManualWriteResult
} from "../../domain/index.js";
import type { ToolFactory } from "../registry.js";
import type { WorkerPorts } from "../ports.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { loadCategories } from "./feed.js";

function today(ports: WorkerPorts): string {
  if (!ports.localTimezone)
    throw new InputError(
      "timezone_required",
      "Update Moss to supply your timezone before manual entry"
    );
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ports.localTimezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(ports.now());
  const get = (type: string) => parts.find((part) => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}
function id(input: Record<string, unknown>, key: string): string {
  const value = readString(input, key, { required: true });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value))
    throw new InputError(`${key} must be a UUID`);
  return `manual:${value}`;
}
function date(input: Record<string, unknown>, key: string, currentDate: string): string {
  const value = readString(input, key, { required: true });
  if (!isCalendarDate(value)) throw new InputError(`${key} must be a valid calendar date`);
  if (value > currentDate)
    throw new InputError(
      "future_date",
      "Posted entries cannot be in the future in your Moss timezone"
    );
  return value;
}
function currency(input: Record<string, unknown>): string {
  const value = readString(input, "isoCurrency", { required: true });
  if (!(MANUAL_CURRENCIES as readonly string[]).includes(value))
    throw new InputError("unsupported_currency", "Choose a supported two-decimal currency");
  return value;
}
const digest = (input: Record<string, unknown>) =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");
async function ledger(ports: WorkerPorts) {
  const store = await ports.store();
  if (!store.manual)
    throw new InputError(
      "storage_upgrade_required",
      "Complete Finance storage migration before manual entry"
    );
  return store.manual;
}
function outcome(result: ManualWriteResult, recordId: string) {
  if (result === "created" || result === "unchanged")
    return { status: "ok", id: recordId, unchanged: result === "unchanged" };
  const messages = {
    conflict: "This operation identity belongs to different entries; check the saved result",
    unavailable: "This manual account is unavailable, archived or has a different currency",
    invalid_date: "The entry date precedes the account opening balance",
    overflow: "The resulting balance exceeds supported precision"
  };
  throw new InputError(`manual_${result}`, messages[result]);
}

export const manualContextHandler: ToolFactory = (ports) => async () => ({
  status: "ok",
  today: today(ports),
  currencies: [...MANUAL_CURRENCIES],
  supported: Boolean((await ports.store()).manual),
  categories: (await loadCategories(ports))
    .filter((category) => !category.archived && category.id !== "transfers")
    .map(({ id, name }) => ({ id, name }))
});
export const manualAccountCreateHandler: ToolFactory = (ports) => async (input) => {
  const store = await ledger(ports);
  const accountId = id(input, "operationId");
  const name = readString(input, "name", { required: true, maxBytes: 320 }).trim();
  if (!name) throw new InputError("name is required");
  const kind = readString(input, "accountType", { required: true });
  if (!(MANUAL_ACCOUNT_TYPES as readonly string[]).includes(kind))
    throw new InputError("accountType is unsupported");
  const values = {
    accountId,
    name,
    ...manualAccountKind(kind as ManualAccountType),
    isoCurrency: currency(input),
    openingDate: date(input, "openingDate", today(ports)),
    openingBalanceCents: readInt(input, "openingBalanceCents", { required: true })
  };
  return outcome(
    await store.createAccount({ ...values, digest: digest(values), at: ports.now().toISOString() }),
    accountId
  );
};
export const manualEntryCreateHandler: ToolFactory = (ports) => async (input) => {
  const store = await ledger(ports);
  const transactionId = id(input, "operationId");
  const accountId = readString(input, "accountId", { required: true, maxBytes: 128 });
  const name = readString(input, "name", { required: true, maxBytes: 640 }).trim();
  if (!name) throw new InputError("name is required");
  const amountCents = readInt(input, "amountCents", { required: true });
  if (amountCents === 0) throw new InputError("amountCents must be nonzero");
  const categoryId = readString(input, "categoryId") || null;
  if (
    categoryId &&
    !(await loadCategories(ports)).some(
      (category) => category.id === categoryId && !category.archived && category.id !== "transfers"
    )
  ) {
    throw new InputError(
      "invalid_category",
      "Choose a current category; linked transfers need their separate workflow"
    );
  }
  const values = {
    id: transactionId,
    accountId,
    name,
    amountCents,
    categoryId,
    isoCurrency: currency(input),
    date: date(input, "date", today(ports)),
    notes: readString(input, "notes", { maxBytes: 4000 }) ?? "",
    cleared: readBool(input, "cleared", { required: true })
  };
  return outcome(
    await store.createEntry({ ...values, digest: digest(values), at: ports.now().toISOString() }),
    transactionId
  );
};
