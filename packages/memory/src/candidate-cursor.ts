import { memoryPendingCandidateCursorPattern } from "@moss/shared";

export interface MemoryCandidateCursor {
  readonly createdAt: string;
  readonly id: string;
}

/** Keep PostgreSQL's microseconds intact; JavaScript Dates only retain milliseconds. */
export function parseMemoryCandidateCursor(value: string): MemoryCandidateCursor | null {
  if (value.length !== 64 || !new RegExp(memoryPendingCandidateCursorPattern).test(value))
    return null;
  const [createdAt, id] = value.split("_") as [string, string];
  const milliseconds = `${createdAt.slice(0, 23)}Z`;
  const date = new Date(milliseconds);
  if (
    createdAt.startsWith("0000-") ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString() !== milliseconds
  )
    return null;
  return { createdAt, id };
}
