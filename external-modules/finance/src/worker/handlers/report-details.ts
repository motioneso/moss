import { deriveReportDetails } from "../../domain/report-details.js";
import { isCalendarMonth } from "../../domain/values.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readEnum, readInt, readString } from "../validate.js";
import { loadReportRows } from "./report-rows.js";
import { accountsListHandler } from "./accounts.js";
export const reportsTransactionsHandler: ToolFactory = (ports) => async (input) => {
  const month = readString(input, "month", { required: true });
  if (!isCalendarMonth(month)) throw new InputError("Choose a valid report month");
  const currency = readString(input, "currency", { required: true });
  if (!/^[A-Z]{3}$/.test(currency))
    throw new InputError("Choose a three-letter uppercase currency");
  const group = readEnum(input, "group", ["category", "payee", "income", "outflow"] as const, {
    required: true
  });
  const key = input.key;
  if ((group === "category" || group === "payee") && (typeof key !== "string" || key.length > 2000))
    throw new InputError("Choose the report category or payee");
  const selected = input.sharedOwnerIds ?? [];
  if (
    !Array.isArray(selected) ||
    selected.length > 100 ||
    selected.some((id) => typeof id !== "string" || id.length > 64)
  )
    throw new InputError("Choose valid shared report owners");
  const offset = readInt(input, "offset", { min: 0, max: 1000000 }) ?? 0,
    limit = readInt(input, "limit", { min: 1, max: 200 }) ?? 50;
  const data = await loadReportRows(ports, input);
  if (!data.window.includes(month))
    throw new InputError(
      "report_scope_changed",
      "This report period changed. Refresh Reports and choose the period again."
    );
  const owners = new Set(selected as string[]);
  const result = deriveReportDetails(
    [
      { ownerUserId: data.actorUserId, shared: false, transactions: data.own },
      ...[...data.sharedByOwner]
        .filter(([id]) => owners.has(id))
        .map(([ownerUserId, transactions]) => ({ ownerUserId, shared: true, transactions }))
    ],
    { month, currency, group, ...(typeof key === "string" ? { key } : {}) },
    offset,
    limit
  );
  const accounts = (await accountsListHandler(ports)(input)).accounts as {
    accountId: string;
    ownerUserId?: string;
    name: string;
  }[];
  return {
    status: "ok",
    month,
    currency,
    group,
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      accountName:
        accounts.find(
          (a) =>
            a.accountId === row.accountId && (a.ownerUserId ?? data.actorUserId) === row.ownerUserId
        )?.name ?? (row.shared ? "Shared account" : "Unavailable account")
    }))
  };
};
