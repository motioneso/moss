import { createHash } from "node:crypto";

/** Bind approval to the full validated JSON input, independent of object-key order. */
export function modulePageInputDigest(input: Record<string, unknown>): Buffer {
  const canonical = (value: unknown, depth: number): string => {
    if (depth > 64) throw new Error("Input nesting exceeds the supported limit");
    if (value === null || typeof value === "string" || typeof value === "boolean")
      return JSON.stringify(value);
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((entry) => canonical(entry, depth + 1)).join(",")}]`;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
        .join(",")}}`;
    }
    throw new Error("Input must contain only finite JSON values");
  };
  return createHash("sha256").update(canonical(input, 0)).digest();
}

export function modulePageInvokeBody(value: unknown): {
  input: Record<string, unknown>;
  confirmationId?: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    Object.keys(body).some((key) => key !== "input" && key !== "confirmationId") ||
    !body.input ||
    typeof body.input !== "object" ||
    Array.isArray(body.input) ||
    (body.confirmationId !== undefined && typeof body.confirmationId !== "string")
  )
    return null;
  return {
    input: body.input as Record<string, unknown>,
    ...(typeof body.confirmationId === "string" ? { confirmationId: body.confirmationId } : {})
  };
}
