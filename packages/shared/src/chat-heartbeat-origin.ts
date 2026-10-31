import { HEARTBEAT_SOURCES, type HeartbeatSource } from "./heartbeat-source-api.js";

/**
 * A check-in message written by code from the heartbeat. Item titles, times and sources come from
 * saved evidence; the model supplies only the intro and one note per item.
 */
export interface ChatHeartbeatOriginV1 {
  readonly version: 1;
  readonly kind: "heartbeat";
  readonly occurrenceId: string;
  readonly items: readonly {
    readonly findingId: string;
    readonly source: HeartbeatSource;
    readonly title: string;
    readonly at: string | null;
    readonly note: string;
  }[];
  readonly intro: string;
}

export const chatHeartbeatOriginSchema = {
  type: "object",
  additionalProperties: false,
  required: ["version", "kind", "occurrenceId", "items", "intro"],
  properties: {
    version: { type: "number", enum: [1] },
    kind: { type: "string", enum: ["heartbeat"] },
    occurrenceId: { type: "string" },
    intro: { type: "string" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["findingId", "source", "title", "at", "note"],
        properties: {
          findingId: { type: "string" },
          source: { type: "string", enum: ["calendar", "tasks", "memory", "sports", "news"] },
          title: { type: "string" },
          at: { anyOf: [{ type: "string" }, { type: "null" }] },
          note: { type: "string" }
        }
      }
    }
  }
} as const;

/** Reads a stored or streamed origin; anything malformed reads as absent. */
export function readChatHeartbeatOrigin(value: unknown): ChatHeartbeatOriginV1 | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== "heartbeat" || record.version !== 1) return undefined;
  if (typeof record.occurrenceId !== "string" || typeof record.intro !== "string") return undefined;
  if (!Array.isArray(record.items)) return undefined;
  const items: ChatHeartbeatOriginV1["items"][number][] = [];
  for (const raw of record.items) {
    const item = (raw ?? {}) as Record<string, unknown>;
    if (
      typeof item.findingId !== "string" ||
      typeof item.source !== "string" ||
      !(HEARTBEAT_SOURCES as readonly string[]).includes(item.source) ||
      typeof item.title !== "string" ||
      typeof item.note !== "string" ||
      (item.at !== null && typeof item.at !== "string")
    ) {
      return undefined;
    }
    items.push({
      findingId: item.findingId,
      source: item.source as HeartbeatSource,
      title: item.title,
      at: item.at as string | null,
      note: item.note
    });
  }
  return {
    version: 1,
    kind: "heartbeat",
    occurrenceId: record.occurrenceId,
    items,
    intro: record.intro
  };
}
