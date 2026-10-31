import { decimalToCents, isCalendarDate } from "./values.js";

export const MAX_IMPORT_ROWS = 200;
export const MAX_IMPORT_BYTES = 1024 * 1024;
export const MAX_IMPORT_ROW_BYTES = 500 * 1024;
export interface ImportRow {
  sourceRow: number;
  date: string;
  name: string;
  amountCents: number;
  notes: string;
  allowDuplicate: boolean;
}
export interface ImportPreview {
  accountId: string;
  isoCurrency: string;
  openingDate: string;
  lastReconciledDate: string | null;
  revision: number;
  balanceCents: number;
  debt: boolean;
  duplicateRows: number[];
}
export interface ImportApply {
  id: string;
  accountId: string;
  isoCurrency: string;
  expectedRevision: number;
  rows: ImportRow[];
  cleared: boolean;
  digest: string;
  at: string;
}
export interface ImportStore {
  preview(accountId: string, rows: ImportRow[]): Promise<ImportPreview | null>;
  apply(input: ImportApply): Promise<"created" | "unchanged" | "conflict">;
}
export interface CsvTable {
  headers: string[];
  rows: string[][];
}
export interface CsvMapping {
  date: number;
  name: number;
  amount: number;
  inflow: number;
  outflow: number;
  notes: number;
  currency: number;
  dateFormat: "iso" | "mdy" | "dmy";
  amountMode: "positive-out" | "positive-in" | "separate";
}
/** Strict bounded RFC 4180 reader. Blank records are not silently discarded. */
export function parseCsv(text: string): CsvTable {
  if (new TextEncoder().encode(text).byteLength > MAX_IMPORT_BYTES)
    throw new Error("Choose a CSV file no larger than 1 MiB.");
  const source = text.replace(/^\uFEFF/, "");
  const records: string[][] = [];
  let fields: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += ch;
    } else if (ch === "," || ch === "\n" || ch === "\r") {
      fields.push(field);
      field = "";
      closed = false;
      if (ch !== ",") {
        if (ch === "\r" && source[i + 1] === "\n") i++;
        records.push(fields);
        fields = [];
        if (records.length > MAX_IMPORT_ROWS + 1)
          throw new Error("Import at most 200 data rows at a time.");
      }
    } else if (ch === '"' && field === "" && !closed) quoted = true;
    else {
      if (closed || ch === '"') throw new Error("The CSV has malformed quotes.");
      field += ch;
    }
  }
  if (quoted) throw new Error("The CSV has an unclosed quoted field.");
  if (field !== "" || fields.length || closed) records.push([...fields, field]);
  const headers = records.shift();
  if (!headers?.length || !records.length)
    throw new Error("Include a header and at least one data row.");
  if (records.length > MAX_IMPORT_ROWS) throw new Error("Import at most 200 data rows at a time.");
  if (headers.length > 50 || records.some((row) => row.length !== headers.length))
    throw new Error("Use at most 50 columns, with the same number of fields on every row.");
  return { headers, rows: records };
}
function csvDate(value: string, format: CsvMapping["dateFormat"]): string {
  let date = value.trim();
  if (format !== "iso") {
    const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(date);
    if (!match) throw new Error("Use the selected date format on every row.");
    date = `${match[3]}-${(format === "mdy" ? match[1] : match[2])!.padStart(2, "0")}-${(format === "mdy" ? match[2] : match[1])!.padStart(2, "0")}`;
  }
  if (!isCalendarDate(date)) throw new Error("Use a valid calendar date on every row.");
  return date;
}
function money(value: string): number {
  const text = value.trim();
  if (!/^-?(?:\d+(?:\.\d{0,2})?|\.\d{1,2})$/.test(text))
    throw new Error(
      "Amounts need a decimal point, no grouping or currency symbols, and at most two decimal places."
    );
  try {
    return decimalToCents(text);
  } catch {
    throw new Error("An amount exceeds supported precision.");
  }
}
export function mapCsv(table: CsvTable, mapping: CsvMapping, isoCurrency: string): ImportRow[] {
  const required = [
    mapping.date,
    mapping.name,
    ...(mapping.amountMode === "separate" ? [mapping.inflow, mapping.outflow] : [mapping.amount])
  ];
  const selected = [...required, mapping.notes, mapping.currency].filter((value) => value !== -1);
  if (
    required.some((value) => value < 0) ||
    selected.some((value) => !Number.isInteger(value) || value >= table.headers.length) ||
    new Set(selected).size !== selected.length
  )
    throw new Error("Choose a different column for each mapped field.");
  const result = table.rows.map((fields, index) => {
    try {
      const name = fields[mapping.name]!.trim();
      const notes = mapping.notes < 0 ? "" : fields[mapping.notes]!;
      if (
        !name ||
        new TextEncoder().encode(name).length > 640 ||
        new TextEncoder().encode(notes).length > 4000
      )
        throw new Error("Payee is required (up to 640 bytes); notes allow up to 4000 bytes.");
      if (mapping.currency >= 0 && fields[mapping.currency]!.trim() !== isoCurrency)
        throw new Error("Every row must use this account's currency.");
      let amountCents: number;
      if (mapping.amountMode === "separate") {
        const inflow = money(fields[mapping.inflow]!.trim() || "0");
        const outflow = money(fields[mapping.outflow]!.trim() || "0");
        if (inflow < 0 || outflow < 0 || (inflow !== 0 && outflow !== 0))
          throw new Error("Use one nonnegative inflow or outflow per row.");
        amountCents = outflow - inflow;
      } else
        amountCents =
          money(fields[mapping.amount]!) * (mapping.amountMode === "positive-out" ? 1 : -1);
      if (amountCents === 0) throw new Error("Zero-value rows cannot be imported.");
      return {
        sourceRow: index + 1,
        date: csvDate(fields[mapping.date]!, mapping.dateFormat),
        name,
        amountCents,
        notes,
        allowDuplicate: false
      };
    } catch (error) {
      throw new Error(`Data row ${index + 1}: ${(error as Error).message}`, { cause: error });
    }
  });
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_IMPORT_ROW_BYTES)
    throw new Error("This batch has too much text. Choose fewer rows or shorter notes.");
  return result;
}
export function importedBalance(
  preview: Pick<ImportPreview, "balanceCents" | "debt">,
  rows: ImportRow[]
): number | null {
  const total =
    BigInt(preview.balanceCents) +
    (preview.debt ? 1n : -1n) * rows.reduce((sum, row) => sum + BigInt(row.amountCents), 0n);
  return total >= -9007199254740991n && total <= 9007199254740991n ? Number(total) : null;
}
