import { randomUUID } from "node:crypto";

import type { AssistantToolGateway } from "@moss/ai";
import {
  HEARTBEAT_SOURCE_READ_TOOLS,
  type HeartbeatEvidenceItem,
  type HeartbeatSource,
  type HeartbeatSourceRead
} from "@moss/shared";

import { HEARTBEAT_READ_HORIZON_HOURS, HEARTBEAT_READ_LIMIT } from "./limits.js";

export type HeartbeatGateway = Pick<AssistantToolGateway, "runBackgroundReadForActor">;

export interface CollectedSources {
  readonly reads: readonly HeartbeatSourceRead[];
  readonly unavailable: readonly HeartbeatSource[];
}

function isItem(value: unknown): value is HeartbeatEvidenceItem {
  const item = value as HeartbeatEvidenceItem | null;
  return (
    typeof item === "object" &&
    item !== null &&
    typeof item.entityKey === "string" &&
    typeof item.episodeKey === "string" &&
    typeof item.title === "string" &&
    (item.at === null || typeof item.at === "string") &&
    typeof item.kind === "string" &&
    typeof item.facts === "object" &&
    item.facts !== null
  );
}

function parseRead(source: HeartbeatSource, value: unknown): HeartbeatSourceRead | null {
  const record = value as Partial<HeartbeatSourceRead> | null;
  if (typeof record !== "object" || record === null) return null;
  if (typeof record.revision !== "string" || !Array.isArray(record.items)) return null;
  if (!record.items.every(isItem)) return null;
  return {
    source,
    revision: record.revision,
    nextBoundaryAt: typeof record.nextBoundaryAt === "string" ? record.nextBoundaryAt : null,
    freshness:
      record.freshness === "fresh" || record.freshness === "stale" ? record.freshness : "unknown",
    truncated: record.truncated === true,
    items: record.items
  };
}

/**
 * Reads each enabled source through the gateway's background path, which re-checks the owner's
 * access on every call. A refused, failed or malformed read marks that source unavailable.
 */
export async function collectSources(
  gateway: HeartbeatGateway,
  actorUserId: string,
  sources: readonly HeartbeatSource[],
  runId: string
): Promise<CollectedSources> {
  const reads: HeartbeatSourceRead[] = [];
  const unavailable: HeartbeatSource[] = [];
  for (const source of sources) {
    try {
      const response = await gateway.runBackgroundReadForActor(actorUserId, {
        operation: HEARTBEAT_SOURCE_READ_TOOLS[source],
        input: { horizonHours: HEARTBEAT_READ_HORIZON_HOURS, limit: HEARTBEAT_READ_LIMIT },
        runId
      });
      const parsed = response.ok
        ? parseRead(source, response.structuredData ?? response.data)
        : null;
      if (parsed) reads.push(parsed);
      else unavailable.push(source);
    } catch {
      unavailable.push(source);
    }
  }
  return { reads, unavailable };
}

/** Candidates get a fresh finding ID each beat; the ID only names the item inside one message. */
export function toCandidates(reads: readonly HeartbeatSourceRead[]) {
  return reads.flatMap((read) =>
    read.items.map((item) => ({ findingId: randomUUID(), source: read.source, item }))
  );
}
