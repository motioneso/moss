import type { FastifyInstance, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { MemoryRepository } from "@moss/memory";
import { handleRouteError } from "@moss/module-sdk";
import { BACKTRACK_STORAGE_CONFIG_KEY, RuntimeConfigResolver } from "@moss/settings";
import {
  BACKTRACK_DELETE_MAX_RANGE_MS,
  backtrackPreferencesRouteSchema,
  type BacktrackDeleteResponse,
  type BacktrackPreferencesRequest,
  type BacktrackPreferencesResponse,
  type BacktrackStatusResponse
} from "@moss/shared";

import { deleteScreenChunksForSegments } from "./jobs.js";
import { BacktrackRepository } from "./repository.js";

export interface BacktrackRouteDependencies {
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  readonly dataContext: DataContextRunner;
  readonly repository?: BacktrackRepository;
  readonly memory?: Pick<MemoryRepository, "deleteChunksForSources">;
}

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
function parseDeleteRange(body: unknown): DeleteRange {
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

/**
 * Backtrack's session-authenticated routes (plan §4.7): status, the pause switch and delete. The
 * module can't be disabled (decision 12) and none of these read the storage switch to refuse, so
 * a person can always see their state and always delete. Nothing here logs a request or response
 * field beyond counts.
 */
export function registerBacktrackRoutes(
  app: FastifyInstance,
  deps: BacktrackRouteDependencies
): void {
  const repository = deps.repository ?? new BacktrackRepository();
  const memory = deps.memory ?? new MemoryRepository();

  app.get("/api/backtrack/status", async (request, reply) => {
    try {
      const accessContext = await deps.resolveAccessContext(request);
      const owner = accessContext.actorUserId;
      return await deps.dataContext.withDataContext(
        accessContext,
        async (scopedDb): Promise<BacktrackStatusResponse> => {
          const storage = await new RuntimeConfigResolver(scopedDb).resolveEnum<"off" | "on">(
            BACKTRACK_STORAGE_CONFIG_KEY
          );
          const prefs = await repository.getPreferences(scopedDb, owner);
          const summary = await repository.getStatusSummary(scopedDb, owner);
          return {
            storage,
            paused: prefs?.paused ?? false,
            macs: summary.macs,
            days: summary.days,
            bytes: summary.bytes,
            ...(summary.oldest ? { oldest: summary.oldest.toISOString() } : {}),
            ...(summary.lastReceivedAt
              ? { lastReceivedAt: summary.lastReceivedAt.toISOString() }
              : {})
          };
        }
      );
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });

  app.put<{ Body: BacktrackPreferencesRequest }>(
    "/api/backtrack/preferences",
    { schema: backtrackPreferencesRouteSchema },
    async (request, reply) => {
      try {
        const accessContext = await deps.resolveAccessContext(request);
        const prefs = await deps.dataContext.withDataContext(accessContext, (scopedDb) =>
          repository.setPaused(scopedDb, accessContext.actorUserId, request.body.paused)
        );
        const response: BacktrackPreferencesResponse = { paused: prefs.paused };
        return response;
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  app.delete("/api/backtrack/segments", async (request, reply) => {
    try {
      const accessContext = await deps.resolveAccessContext(request);
      const owner = accessContext.actorUserId;
      const range = parseDeleteRange(request.body);
      if (range.kind === "invalid") return reply.code(400).send({ error: range.message });

      const deleted = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
        await repository.lockOwner(scopedDb, owner);
        // The cut is taken under the lock, so an upload committed while this waited is older than
        // it. The marker and the delete share one bound: a range reaching past now is cut at now,
        // and "Everything" means everything up to now (decision 10).
        const deletedAt = new Date();
        const from = range.kind === "range" ? range.from : null;
        const to =
          range.kind === "range"
            ? new Date(Math.min(range.to.getTime(), deletedAt.getTime()))
            : deletedAt;
        // A range that starts in the future (a day not yet begun) holds nothing yet: no marker,
        // since one with its lower bound past its upper bound is no range at all.
        if (from && from.getTime() >= to.getTime()) return 0;

        // Marker first, then segments, then their chunks, in one transaction under the owner lock:
        // an ingest retry waits on the lock and then meets the marker, so it can't undo the delete.
        await repository.insertDeletionMarker(scopedDb, owner, from, to, deletedAt);
        const ids = await repository.deleteSegmentsInRange(scopedDb, owner, { from, to });
        await deleteScreenChunksForSegments(memory, scopedDb, owner, ids);
        return ids.length;
      });

      const response: BacktrackDeleteResponse = { deleted };
      return response;
    } catch (error) {
      return handleRouteError(error, reply);
    }
  });
}
