/**
 * Contract for the bounded, cache-only source reads the heartbeat runs in the background.
 * Each owning module declares one read tool that returns a `HeartbeatSourceRead`.
 */

export const HEARTBEAT_SOURCES = ["calendar", "tasks", "memory", "sports", "news"] as const;

export type HeartbeatSource = (typeof HEARTBEAT_SOURCES)[number];

export const HEARTBEAT_MAX_HORIZON_HOURS = 48;
export const HEARTBEAT_MAX_ITEMS = 20;

export interface HeartbeatSourceReadInput {
  readonly horizonHours: number; // bounded, max 48
  readonly limit: number; // max 20
}

export interface HeartbeatEvidenceItem {
  readonly entityKey: string; // owner-scoped opaque key, stable across rewording
  readonly episodeKey: string; // changes only on a new material occurrence
  readonly title: string;
  readonly at: string | null; // ISO time or local date
  readonly kind: string; // e.g. "task_due", "event", "commitment_due", "fixture"
  readonly facts: Readonly<Record<string, string | number | boolean | null>>;
}

export type HeartbeatSourceRead = {
  readonly source: HeartbeatSource;
  readonly revision: string; // cheap material revision, e.g. max updated_at plus count
  readonly nextBoundaryAt: string | null;
  readonly freshness: "fresh" | "stale" | "unknown";
  readonly truncated: boolean;
  readonly items: readonly HeartbeatEvidenceItem[];
};

export const HEARTBEAT_SOURCE_READ_TOOLS: Readonly<Record<HeartbeatSource, string>> = {
  calendar: "calendar.heartbeatWindow",
  tasks: "tasks.heartbeatWindow",
  memory: "commitments.heartbeatOpen",
  sports: "sports.heartbeatNextFixtures",
  news: "news.heartbeatHeadlines"
};

export const heartbeatSourceReadInputSchema = {
  type: "object",
  properties: {
    horizonHours: { type: "integer", minimum: 1, maximum: HEARTBEAT_MAX_HORIZON_HOURS },
    limit: { type: "integer", minimum: 1, maximum: HEARTBEAT_MAX_ITEMS }
  },
  additionalProperties: false
} as const;

/**
 * Parses a background read's input. Returns null for anything outside the contract, including
 * extra keys such as an owner or user id, so a caller cannot name another person's data.
 */
export function parseHeartbeatSourceReadInput(input: unknown): HeartbeatSourceReadInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "horizonHours" && key !== "limit") return null;
  }
  const horizonHours = record.horizonHours ?? 24;
  const limit = record.limit ?? HEARTBEAT_MAX_ITEMS;
  if (
    !Number.isInteger(horizonHours) ||
    (horizonHours as number) < 1 ||
    (horizonHours as number) > HEARTBEAT_MAX_HORIZON_HOURS
  )
    return null;
  if (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > HEARTBEAT_MAX_ITEMS)
    return null;
  return { horizonHours: horizonHours as number, limit: limit as number };
}

/** 32-bit FNV-1a over the parts, so a revision never depends on the current time. */
export function heartbeatRevision(parts: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${parts.length}-${hash.toString(16).padStart(8, "0")}`;
}

/** Applies the item cap and reports whether anything was cut. */
export function capHeartbeatItems<T>(
  items: readonly T[],
  limit: number
): { readonly items: T[]; readonly truncated: boolean } {
  const bounded = Math.min(limit, HEARTBEAT_MAX_ITEMS);
  return { items: items.slice(0, bounded), truncated: items.length > bounded };
}

/** The only tools a background run may read, each of which must also declare its own check. */
export const BACKGROUND_READ_OPERATIONS: ReadonlySet<string> = new Set([
  "tasks.get",
  ...Object.values(HEARTBEAT_SOURCE_READ_TOOLS)
]);
