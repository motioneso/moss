import type { ReviewedTransaction } from "../../domain/transaction-bulk.js";
import { InputError, readString } from "../validate.js";
/** Validate opaque change detectors; they never substitute for the SQL owner boundary. */
export function readReviewedRows(raw: unknown): ReviewedTransaction[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 200)
    throw new InputError("Choose between 1 and 200 loaded transactions");
  const rows = raw.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new InputError("Review each transaction before saving");
    const id = readString(value, "id", { required: true });
    const writeRevision = readString(value, "writeRevision", { required: true });
    if (!id || id.length > 256 || !/^[a-f0-9]{32}$/.test(writeRevision))
      throw new InputError("Review each transaction before saving");
    return { id, writeRevision };
  });
  if (new Set(rows.map((r) => r.id)).size !== rows.length)
    throw new InputError("Choose each transaction only once");
  return rows;
}
