import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  deleteMemoryEntityDashboardRouteSchema,
  getMemoryDashboardRouteSchema,
  getMemoryPendingCandidatesRouteSchema,
  patchMemoryEntityDashboardRouteSchema,
  patchMemoryFactDashboardRouteSchema,
  postMemoryCandidateAcceptRouteSchema,
  postMemoryCandidateRejectRouteSchema,
  postMemoryCandidateSuppressRouteSchema
} from "@moss/shared";
import { RuntimeConfigResolver } from "@moss/settings";

import { pendingCandidateItem } from "./candidate-labels.js";
import { MemoryCandidatesRepository } from "./candidates-repository.js";
import { MemoryDashboardService } from "./dashboard-service.js";
import type {
  AcceptMemoryCandidateRequest,
  MemoryDashboardQuery,
  PatchMemoryEntityDashboardRequest,
  PatchMemoryFactDashboardRequest
} from "./dashboard-types.js";
import {
  createEmbeddingProvider,
  getEmbeddingProviderConfig
} from "./embedding-provider-config.js";
import { MemoryGraphRepository } from "./graph-repository.js";

const PENDING_CANDIDATE_LIMIT = 50;

export interface MemoryDashboardRouteDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
}

export function registerMemoryDashboardRoutes(
  server: FastifyInstance,
  dependencies: MemoryDashboardRouteDependencies
): void {
  const graphRepo = new MemoryGraphRepository();
  const candidatesRepo = new MemoryCandidatesRepository();

  server.get(
    "/api/memory/dashboard",
    { schema: getMemoryDashboardRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const q = request.query as Record<string, unknown>;
        const query: MemoryDashboardQuery = {
          status: q.status as MemoryDashboardQuery["status"],
          recordKind: q.recordKind as MemoryDashboardQuery["recordKind"],
          q: typeof q.q === "string" ? q.q : undefined,
          limit: typeof q.limit === "number" ? q.limit : undefined,
          cursor: typeof q.cursor === "string" ? q.cursor : undefined
        };
        return await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.getDashboard(scopedDb, access.actorUserId, query);
        });
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/memory/candidates",
    { schema: getMemoryPendingCandidatesRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        return await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const pending = await candidatesRepo.listPending(
            scopedDb,
            access.actorUserId,
            PENDING_CANDIDATE_LIMIT
          );
          return { items: pending.map(pendingCandidateItem) };
        });
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/memory/candidates/:id/accept",
    {
      schema: postMemoryCandidateAcceptRouteSchema,

      // A plain accept has nothing to send; treat a missing body as an empty one.
      preValidation: async (request) => {
        request.body ??= {};
      }
    },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as AcceptMemoryCandidateRequest;
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.acceptCandidate(scopedDb, access.actorUserId, id, body);
        });
        if (!result.accepted)
          return reply.code(404).send({ error: "Candidate not found or not pending" });
        return reply.code(200).send({ accepted: true });
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/memory/candidates/:id/reject",
    { schema: postMemoryCandidateRejectRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { reason?: string };
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.rejectCandidate(scopedDb, access.actorUserId, id, body.reason ?? "");
        });
        if (!result.rejected) return reply.code(404).send({ error: "Candidate not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/memory/candidates/:id/suppress",
    { schema: postMemoryCandidateSuppressRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const body = (request.body ?? {}) as { reason?: string };
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.suppressCandidate(scopedDb, access.actorUserId, id, body.reason ?? "");
        });
        if (!result.suppressed) return reply.code(404).send({ error: "Candidate not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/memory/graph/facts/:id",
    { schema: patchMemoryFactDashboardRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const patch = (request.body ?? {}) as PatchMemoryFactDashboardRequest;
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.patchFact(scopedDb, access.actorUserId, id, patch);
        });
        if (!result.patched) return reply.code(404).send({ error: "Fact not found" });
        return reply.code(200).send({ patched: true });
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/memory/graph/entities/:id",
    { schema: patchMemoryEntityDashboardRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const patch = (request.body ?? {}) as PatchMemoryEntityDashboardRequest;
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.patchEntity(scopedDb, access.actorUserId, id, patch);
        });
        if (!result.patched) return reply.code(404).send({ error: "Entity not found" });
        return reply.code(200).send({ patched: true });
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/memory/graph/entities/:id",
    { schema: deleteMemoryEntityDashboardRouteSchema },
    async (request, reply) => {
      try {
        const access = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const result = await dependencies.dataContext.withDataContext(access, async (scopedDb) => {
          const svc = await createDashboardService(scopedDb, graphRepo);
          return svc.deleteEntity(scopedDb, access.actorUserId, id);
        });
        if (result.blockedByFacts) {
          return reply.code(409).send({ error: "Entity has associated facts; delete facts first" });
        }
        if (!result.deleted) return reply.code(404).send({ error: "Entity not found" });
        return reply.code(204).send();
      } catch (error) {
        return handleDashboardRouteError(error, reply);
      }
    }
  );
}

async function createDashboardService(
  scopedDb: DataContextDb,
  graphRepo: MemoryGraphRepository
): Promise<MemoryDashboardService> {
  const config = await getEmbeddingProviderConfig(new RuntimeConfigResolver(scopedDb));
  return new MemoryDashboardService(graphRepo, createEmbeddingProvider(config));
}

function handleDashboardRouteError(error: unknown, reply: FastifyReply) {
  if (error instanceof Error && error.message === "Unauthorized") {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  if (
    error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ENTITY_HAS_ACTIVE_FACTS"
  ) {
    return reply.code(409).send({ error: error.message });
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "EMPTY_OBJECT_TEXT") {
    return reply.code(400).send({ error: error.message });
  }
  if (error instanceof Error && (error as NodeJS.ErrnoException).code === "SELF_ENTITY_PROTECTED") {
    return reply.code(403).send({ error: error.message });
  }
  throw error;
}
