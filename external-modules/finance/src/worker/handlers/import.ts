import {
  MAX_IMPORT_ROW_BYTES,
  MAX_IMPORT_ROWS,
  importedBalance,
  type ImportRow
} from "../../domain/csv-import.js";
import type { ToolFactory } from "../registry.js";
import { InputError, readBool, readInt, readString } from "../validate.js";
import { currency, date, digest, id, today } from "./manual-ledger.js";

function rows(input: Record<string, unknown>, currentDate: string): ImportRow[] {
  if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > MAX_IMPORT_ROWS)
    throw new InputError("Import between 1 and 200 rows");
  const parsed = input.rows.map((raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new InputError("rows must contain entries");
    const value = raw as Record<string, unknown>;
    const name = readString(value, "name", { required: true, maxBytes: 640 }).trim();
    const amountCents = readInt(value, "amountCents", { required: true });
    if (!name || !amountCents) throw new InputError("rows need a payee and nonzero amount");
    return {
      sourceRow: readInt(value, "sourceRow", { required: true, min: 1, max: MAX_IMPORT_ROWS }),
      date: date(value, "date", currentDate),
      name,
      amountCents,
      notes: readString(value, "notes", { maxBytes: 4000 }) ?? "",
      allowDuplicate: readBool(value, "allowDuplicate", { required: true })
    };
  });
  if (new Set(parsed.map((row) => row.sourceRow)).size !== parsed.length)
    throw new InputError("sourceRow must be distinct");
  if (Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_IMPORT_ROW_BYTES)
    throw new InputError("import_too_large", "Import text exceeds supported batch size");
  return parsed.sort((a, b) => a.sourceRow - b.sourceRow);
}
export const importPreviewHandler: ToolFactory = (ports) => async (input) => {
  const store = (await ports.store()).imports;
  if (!store) throw new InputError("storage_upgrade_required", "Finance storage needs an update");
  const currentDate = today(ports);
  const entries = rows(input, currentDate);
  const isoCurrency = currency(input);
  const accountId = readString(input, "accountId", { required: true, maxBytes: 128 });
  const view = await store.preview(accountId, entries);
  if (!view || view.isoCurrency !== isoCurrency)
    throw new InputError("manual_unavailable", "Manual account is unavailable or currency differs");
  if (entries.some((row) => row.date < view.openingDate))
    throw new InputError("manual_invalid_date", "An entry precedes the opening balance");
  if (entries.some((row) => view.lastReconciledDate && row.date <= view.lastReconciledDate))
    throw new InputError("manual_reconciled_period", "An entry is in a reconciled period");
  return {
    status: "ok",
    today: currentDate,
    view,
    resultingBalanceCents: importedBalance(view, entries)
  };
};
export const importApplyHandler: ToolFactory = (ports) => async (input) => {
  const store = (await ports.store()).imports;
  if (!store) throw new InputError("storage_upgrade_required", "Finance storage needs an update");
  const values = {
    id: id(input, "operationId"),
    accountId: readString(input, "accountId", { required: true, maxBytes: 128 }),
    isoCurrency: currency(input),
    expectedRevision: readInt(input, "expectedRevision", { required: true, min: 0 }),
    rows: rows(input, today(ports)),
    cleared: readBool(input, "cleared", { required: true })
  };
  const result = await store.apply({
    ...values,
    digest: digest(values),
    at: ports.now().toISOString()
  });
  if (result === "conflict")
    throw new InputError(
      "stale_import",
      "The import no longer matches the ledger or needs duplicate decisions; refresh the preview before applying"
    );
  return {
    status: "ok",
    id: values.id,
    entryCount: values.rows.length,
    unchanged: result === "unchanged"
  };
};
