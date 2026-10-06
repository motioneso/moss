import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextRunner, DataContextDb } from "@moss/db";
import {
  getMemoryGraphCoreRouteSchema,
  getMemoryGraphRecallRouteSchema,
  postMemoryGraphConfirmRouteSchema,
  postMemoryGraphCorrectRouteSchema,
  postMemoryGraphEntityRouteSchema,
  postMemoryGraphFactRouteSchema,
  postMemoryGraphMarkStaleRouteSchema,
  postMemoryGraphPinRouteSchema,
  postMemoryGraphStatusRouteSchema,
  postMemoryGraphSupersedeRouteSchema
} from "@moss/shared";
import { RuntimeConfigResolver } from "@moss/settings";

import {
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "./embedding-provider-config.js";
import { GraphMemoryRecallService } from "./graph-recall-service.js";
import { MemoryGraphRepository } from "./graph-repository.js";
import type { MemoryRememberInput, NewMemoryEntity } from "./graph-types.js";

export interface MemoryGraphRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
}

export function registerMemoryGraphRoutes(
  server: FastifyInstance,
  dependencies: MemoryGraphRouteDependencies
): void {
  const repository = new MemoryGraphRepository();

  server.get(
    "/api/memory/graph/recall",
    { schema: getMemoryGraphRecallRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const query = String((request.query as { q?: unknown }).q ?? "").trim();
        const rawLimit = Number((request.query as { limit?: unknown }).limit);
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.trunc(rawLimit)) : undefined;
        const includeInactive =
          (request.query as { includeInactive?: unknown }).includeInactive === true;
        const includeStale = (request.query as { includeStale?: unknown }).includeStale === true;
        const includeLowConfidence =
          (request.query as { includeLowConfidence?: unknown }).includeLowConfidence === true;
        if (!query) return reply.code(400).send({ error: "q is required" });
        return dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).recall(scopedDb, access.actorUserId, query, {
            limit,
            includeInactive,
            includeStale,
            includeLowConfidence
          })
        );
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/memory/graph/core",
    { schema: getMemoryGraphCoreRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        return dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).core(scopedDb, access.actorUserId)
        );
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/memory/graph/entities",
    { schema: postMemoryGraphEntityRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const body = request.body as NewMemoryEntity;
        const entity = await dependencies.dataContext.withDataContext(access, (scopedDb) =>
          repository.createEntity(scopedDb, access.actorUserId, body)
        );
        return { entity };
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/memory/graph/facts",
    { schema: postMemoryGraphFactRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const body = request.body as MemoryRememberInput;
        return dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).remember(scopedDb, access.actorUserId, body)
        );
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/pin",
    { schema: postMemoryGraphPinRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const pinned = Boolean((request.body as { pinned?: unknown }).pinned);
        const found = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).pin(
            scopedDb,
            access.actorUserId,
            { factId: request.params.id },
            pinned
          )
        );
        if (!found) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/confirm",
    { schema: postMemoryGraphConfirmRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const fact = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).confirm(scopedDb, access.actorUserId, {
            factId: request.params.id
          })
        );
        if (!fact) return reply.code(404).send({ error: "Memory fact not found" });
        return { fact };
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/correct",
    { schema: postMemoryGraphCorrectRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const body = request.body as { replacementText: string; correctionReason?: string };
        const fact = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).correct(scopedDb, access.actorUserId, {
            targetFactId: request.params.id,
            replacementText: body.replacementText,
            correctionReason: body.correctionReason
          })
        );
        if (!fact) return reply.code(404).send({ error: "Memory fact not found" });
        return { fact };
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/status",
    { schema: postMemoryGraphStatusRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const body = request.body as {
          status: "active" | "stale" | "expired" | "rejected";
          reason?: string;
        };
        const fact = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).patchStatus(
            scopedDb,
            access.actorUserId,
            request.params.id,
            body
          )
        );
        if (!fact) return reply.code(404).send({ error: "Memory fact not found" });
        return { fact };
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/mark-stale",
    { schema: postMemoryGraphMarkStaleRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const fact = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).markStale(scopedDb, access.actorUserId, {
            factId: request.params.id
          })
        );
        if (!fact) return reply.code(404).send({ error: "Memory fact not found" });
        return { fact };
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.post<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id/supersede",
    { schema: postMemoryGraphSupersedeRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const validToRaw = (request.body as { validTo?: string | null } | null)?.validTo;
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).supersede(scopedDb, access.actorUserId, {
            factId: request.params.id,
            validTo: validToRaw ? new Date(validToRaw) : undefined
          })
        );
        if (!result.superseded) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );

  server.delete<{ Params: { id: string } }>(
    "/api/memory/graph/facts/:id",
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) =>
          (await createGraphService(scopedDb)).forget(scopedDb, access.actorUserId, {
            factId: request.params.id
          })
        );
        if (!result.deleted) return reply.code(404).send({ error: "Memory fact not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleMemoryGraphRouteError(error, reply);
      }
    }
  );
}

async function createGraphService(scopedDb: DataContextDb): Promise<GraphMemoryRecallService> {
  const config = await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
  return new GraphMemoryRecallService(createEmbeddingProvider(config));
}

function handleMemoryGraphRouteError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.message === "Unauthorized") {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  if (error instanceof Error && error.message.includes("requires exactly one object target")) {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof Error && error.message.includes("conflict-group memory")) {
    return reply.code(400).send({ error: error.message });
  }
  if (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "SUPERSEDED_REACTIVATION_BLOCKED"
  ) {
    return reply.code(400).send({ error: error.message });
  }
  throw error;
}
