import { createHash } from "node:crypto";
import { isUuid } from "@moss/db";
import type { BoundedActionScope } from "@moss/shared";

/** Keys are sorted so jsonb storage cannot change the exact-terms binding. */
export function termsFingerprint(terms: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, stable(v)])
      );
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(terms)))
    .digest("hex");
}

export function boundedActionScope(value: unknown): BoundedActionScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 7 ||
    row.operation !== "tasks.updateStatus" ||
    row.status !== "done" ||
    typeof row.taskId !== "string" ||
    !isUuid(row.taskId) ||
    typeof row.taskTitle !== "string" ||
    !row.taskTitle.trim() ||
    row.taskTitle.length > 400 ||
    typeof row.dueAt !== "string" ||
    !Number.isFinite(Date.parse(row.dueAt)) ||
    new Date(row.dueAt).toISOString() !== row.dueAt ||
    typeof row.timeZone !== "string" ||
    typeof row.destinationThreadId !== "string" ||
    !isUuid(row.destinationThreadId)
  )
    return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: row.timeZone });
  } catch {
    return undefined;
  }
  return {
    operation: row.operation,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    status: row.status,
    dueAt: row.dueAt,
    timeZone: row.timeZone,
    destinationThreadId: row.destinationThreadId
  };
}

/** Revised terms, quotes and longer acknowledgments confer no agreement. */
export function typedResponsibilityAgreement(text: string): boolean | undefined {
  if (/^yes[.!]?$/i.test(text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""))) return true;
  if (/^no[.!]?$/i.test(text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, ""))) return false;
  return undefined;
}
