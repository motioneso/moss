import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { RuntimeConfigResolver } from "@moss/settings";
import { HttpError, type ToolExecute, type ToolResult } from "@moss/module-sdk";
import type { MemoryForgetToolService } from "./forget-service.js";

import {
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "./embedding-provider-config.js";
import { GraphMemoryRecallService } from "./graph-recall-service.js";
import type {
  MemoryFactPredicate,
  MemoryFactProvenance,
  MemoryEpisodeKind
} from "./graph-types.js";

export const memoryRecallExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const query = typeof input.query === "string" ? input.query.trim() : "";
  const rawLimit = Number(input.limit);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.trunc(rawLimit)) : undefined;
  if (!query) return { data: { query: "", items: [] } };

  const result = await (
    await createService(scopedDb)
  ).recall(scopedDb, ctx.actorUserId, query, {
    limit
  });
  return {
    data: { ...result }
  };
};

export const memoryRememberExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const result = await (
    await createService(scopedDb)
  ).remember(scopedDb, ctx.actorUserId, {
    subjectEntityId: optionalString(input.subjectEntityId),
    predicate: requiredString(input.predicate) as MemoryFactPredicate,
    objectEntityId: optionalString(input.objectEntityId),
    objectText: optionalString(input.objectText),
    confidence: optionalNumber(input.confidence),
    provenance: optionalString(input.provenance) as MemoryFactProvenance | undefined,
    importance: optionalNumber(input.importance),
    pinned: typeof input.pinned === "boolean" ? input.pinned : undefined,
    source: {
      sourceKind: requiredString(
        (input.source as Record<string, unknown>).sourceKind
      ) as MemoryEpisodeKind,
      sourceRef: requiredString((input.source as Record<string, unknown>).sourceRef),
      sourceLabel: optionalString((input.source as Record<string, unknown>).sourceLabel),
      excerpt: requiredString((input.source as Record<string, unknown>).excerpt)
    }
  });
  return { data: { factId: result.fact.id } };
};

export const memoryForgetExecute: ToolExecute = async (
  _scopedDb,
  input,
  ctx,
  services
): Promise<ToolResult> => {
  const factId = requiredString(input.factId);
  const service = services?.memoryForget as MemoryForgetToolService | undefined;
  if (!service || typeof service.forget !== "function") {
    throw new HttpError(503, "Memory deletion is not ready. Start a new chat and try again.");
  }
  const result = await service.forget(factId, ctx);
  return {
    data: { ...result }
  };
};

async function createService(scopedDb: DataContextDb): Promise<GraphMemoryRecallService> {
  const config = await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
  return new GraphMemoryRecallService(createEmbeddingProvider(config));
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Expected non-empty string");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
