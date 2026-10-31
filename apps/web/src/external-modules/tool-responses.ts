/** Only these bounded metadata fields may become host confirmation copy. Never render raw input. */
export interface ModuleToolConfirmation {
  readonly id: string;
  readonly expiresAt: string;
  readonly moduleName: string;
  readonly actionLabel: string;
  readonly risk: "write" | "outbound" | "destructive";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readModuleConfirmation(body: unknown): ModuleToolConfirmation | null {
  if (!isRecord(body) || !isRecord(body.invocation) || !isRecord(body.confirmation)) return null;
  if (body.invocation.status !== "blocked" || body.invocation.reason !== "confirmation_required")
    return null;
  const c = body.confirmation;
  if (
    typeof c.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(c.id) ||
    typeof c.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(c.expiresAt)) ||
    typeof c.moduleName !== "string" ||
    c.moduleName.length === 0 ||
    c.moduleName.length > 160 ||
    typeof c.actionLabel !== "string" ||
    c.actionLabel.length === 0 ||
    c.actionLabel.length > 240 ||
    !["write", "outbound", "destructive"].includes(String(c.risk))
  )
    return null;
  return {
    id: c.id,
    expiresAt: c.expiresAt,
    moduleName: c.moduleName,
    actionLabel: c.actionLabel,
    risk: c.risk as ModuleToolConfirmation["risk"]
  };
}

/** Snapshot now: a module mutating its form later must not change a confirmed request. */
export function snapshotModuleToolInput(value: Record<string, unknown>): Record<string, unknown> {
  const check = (entry: unknown, depth: number): void => {
    if (depth > 64) throw new Error("Input is too deeply nested");
    if (entry === null || typeof entry === "boolean" || typeof entry === "string") return;
    if (typeof entry === "number" && Number.isFinite(entry)) return;
    if (Array.isArray(entry)) {
      entry.forEach((item) => check(item, depth + 1));
      return;
    }
    if (
      isRecord(entry) &&
      (Object.getPrototypeOf(entry) === Object.prototype || Object.getPrototypeOf(entry) === null)
    ) {
      Object.values(entry).forEach((item) => check(item, depth + 1));
      return;
    }
    throw new Error("Input must be JSON");
  };
  if (!isRecord(value)) throw new Error("Input must be an object");
  check(value, 0);
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > 900_000) throw new Error("Input is too large");
  return JSON.parse(text) as Record<string, unknown>;
}
