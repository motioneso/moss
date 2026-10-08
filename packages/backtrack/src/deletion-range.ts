import { BACKTRACK_DELETE_MAX_RANGE_MS } from "@moss/shared";

type DeleteRange =
  | { readonly kind: "everything" }
  | { readonly kind: "range"; readonly from: Date; readonly to: Date }
  | { readonly kind: "invalid"; readonly message: string };

function parseBound(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Decision 7: both bounds or neither, `from` before `to`, at most 31 days apart. */
export function parseDeleteRange(body: unknown): DeleteRange {
  if (body === undefined || body === null) return { kind: "everything" };
  if (typeof body !== "object" || Array.isArray(body)) {
    return { kind: "invalid", message: "Send a from and to, or nothing" };
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "from" && key !== "to")) {
    return { kind: "invalid", message: "Send a from and to, or nothing" };
  }
  const hasFrom = record.from !== undefined;
  const hasTo = record.to !== undefined;
  if (!hasFrom && !hasTo) return { kind: "everything" };
  if (hasFrom !== hasTo) return { kind: "invalid", message: "Send both from and to, or neither" };

  const from = parseBound(record.from);
  const to = parseBound(record.to);
  if (!from || !to) return { kind: "invalid", message: "from and to must be timestamps" };
  if (from.getTime() >= to.getTime()) {
    return { kind: "invalid", message: "from must be before to" };
  }
  if (to.getTime() - from.getTime() > BACKTRACK_DELETE_MAX_RANGE_MS) {
    return { kind: "invalid", message: "A range can span at most 31 days" };
  }
  return { kind: "range", from, to };
}
