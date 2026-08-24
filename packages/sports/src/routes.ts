import type { FastifyInstance, FastifyRequest } from "fastify";

import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextRunner } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import type { NewsAiPort } from "@moss/news";
import {
  confirmSportsSourceSchema,
  createSportsFollowResponseSchema,
  deleteSportsCustomSourceSchema,
  deleteSportsFollowResponseSchema,
  previewSportsSourceSchema,
  sportsCatalogResponseSchema,
  sportsCustomSourcesResponseSchema,
  sportsFollowsResponseSchema,
  sportsLeagueTeamsResponseSchema,
  sportsOverviewResponseSchema,
  sportsStandingsResponseSchema,
  sportsTeamSearchResponseSchema,
  updateSportsSourceAssignmentsSchema,
  type ConfirmSportsSourceRequest,
  type CreateSportsFollowRequest,
  type PreviewSportsSourceRequest,
  type UpdateSportsSourceAssignmentsRequest
} from "@moss/shared";

import { SportsFollowsRepository } from "./repository.js";
import { SportsService, type SportsFollowsWriter } from "./sports-service.js";
import { catalogEntry } from "./source/catalog.js";
import {
  resolveSportsSourceInput,
  type SportsDiscoveryBrowserPort,
  type SportsSafeFetchPort
} from "./source/discovery.js";
import { SportsSourcesRepository } from "./source/repository.js";
import { createSportsPreviewStore } from "./source/preview-store.js";

type SportsSourcePreviewStore = ReturnType<typeof createSportsPreviewStore>;

export interface SportsRoutesDependencies {
  readonly dataContext: DataContextRunner;
  readonly resolveAccessContext: (request: FastifyRequest) => Promise<AccessContext>;
  /**
   * The dataset-connector-SDK runtime client bound to the sports module's `espn` external
   * source (composition root: `packages/module-registry/src/index.ts`). Replaces the former
   * directly-injected `SportsSource`.
   */
  readonly datasetClient: DatasetClient;
  /** Optional injection point for tests; defaults to a real `SportsFollowsRepository`. */
  readonly repository?: SportsFollowsWriter;
  /** Clock seam forwarded to the service (default `() => new Date()`). */
  readonly now?: () => Date;
  /** #1572 custom source discovery — required for the preview/confirm/list/assign/delete routes. */
  readonly discovery: {
    readonly fetch: SportsSafeFetchPort;
    readonly ai: NewsAiPort;
    readonly browser?: SportsDiscoveryBrowserPort;
  };
  /** Optional injection point for tests; defaults to a real `SportsSourcesRepository`. */
  readonly sourcesRepository?: SportsSourcesRepository;
  /** Optional injection point for tests; defaults to a private in-memory store. */
  readonly previews?: SportsSourcePreviewStore;
}

export function registerSportsRoutes(
  server: FastifyInstance,
  dependencies: SportsRoutesDependencies
): void {
  const repository: SportsFollowsWriter = dependencies.repository ?? new SportsFollowsRepository();
  const service = new SportsService({
    datasetClient: dependencies.datasetClient,
    dataContext: dependencies.dataContext,
    repository,
    now: dependencies.now
  });
  const sourcesRepository = dependencies.sourcesRepository ?? new SportsSourcesRepository();
  const previews = dependencies.previews ?? createSportsPreviewStore();

  server.get(
    "/api/sports/catalog",
    { schema: sportsCatalogResponseSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        return await service.getCatalog();
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/leagues/:competitionKey/teams",
    { schema: sportsLeagueTeamsResponseSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const { competitionKey } = request.params as { competitionKey: string };
        // Same authorization-by-catalog rule as POST /follows: being in SPORTS_CATALOG is what
        // makes a competition queryable (#907).
        if (!catalogEntry(competitionKey)) {
          throw new HttpError(400, `Unknown competition: ${competitionKey}`);
        }
        return await service.getLeagueTeams(competitionKey);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/teams/search",
    { schema: sportsTeamSearchResponseSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const { q } = request.query as { q: string };
        return await service.searchTeams(q);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/overview",
    { schema: sportsOverviewResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        return await service.getOverview(accessContext);
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/standings",
    { schema: sportsStandingsResponseSchema },
    async (request, reply) => {
      try {
        await dependencies.resolveAccessContext(request);
        const { competitionKey } = request.query as { competitionKey: string };
        if (!catalogEntry(competitionKey)) {
          throw new HttpError(400, `Unknown competition: ${competitionKey}`);
        }
        const { group, fixtures } = await service.getStandings(competitionKey);
        return { group, fixtures };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/follows",
    { schema: sportsFollowsResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const follows = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          repository.list(db)
        );
        return { follows };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/follows",
    { schema: createSportsFollowResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as CreateSportsFollowRequest;
        const result = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          service.followTeam(db, input)
        );
        if (!result.ok) throw new HttpError(400, result.error);
        return { follow: result.follow };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/sports/follows/:id",
    { schema: deleteSportsFollowResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        // Stays on the raw repository, not service.unfollowTeam: REST already has the row id
        // (from GET /api/sports/follows), so the service's catalogKey -> id resolution is only
        // needed by the assistant tool, which never sees row ids (#1265).
        const { id } = request.params as { id: string };
        const ok = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          repository.remove(db, id)
        );
        return { ok };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.get(
    "/api/sports/sources",
    { schema: sportsCustomSourcesResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const sources = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourcesRepository.list(db)
        );
        return { sources };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/sources/preview",
    { schema: previewSportsSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as PreviewSportsSourceRequest;
        return await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const result = await resolveSportsSourceInput(db, dependencies.discovery, {
            rawUrl: input.url
          });
          if (result.status !== "ok") return result;

          const confirmationId = previews.put({
            ownerUserId: accessContext.actorUserId,
            candidate: result.candidate,
            createdAt: Date.now()
          });
          const existing = await sourcesRepository.list(db);
          const duplicate = existing.find(
            (source) => source.canonicalDomain === result.candidate.canonicalDomain
          );
          return {
            status: "ok" as const,
            confirmationId,
            candidate: {
              label: result.candidate.label,
              canonicalDomain: result.candidate.canonicalDomain,
              homepageUrl: result.candidate.homepageUrl,
              retrievalMethod: result.candidate.retrievalMethod,
              sampleCount: result.candidate.sampleCount
            },
            ...(duplicate ? { duplicateOfSourceId: duplicate.id } : {})
          };
        });
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/sources",
    { schema: confirmSportsSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as ConfirmSportsSourceRequest;
        const source = await dependencies.dataContext.withDataContext(accessContext, async (db) => {
          const preview = previews.take(accessContext.actorUserId, input.confirmationId);
          if (!preview) {
            throw new HttpError(409, "Source preview expired or was not found");
          }
          const created = await sourcesRepository.create(db, { candidate: preview.candidate });
          if ("limitExceeded" in created) {
            throw new HttpError(400, "A maximum of 10 custom sources is allowed");
          }
          if (input.followIds && input.followIds.length > 0) {
            const assigned = await sourcesRepository.setAssignments(
              db,
              created.id,
              input.followIds
            );
            if (assigned) return assigned;
          }
          return created;
        });
        reply.code(201);
        return { source };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/sports/sources/:id/assignments",
    { schema: updateSportsSourceAssignmentsSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const input = request.body as UpdateSportsSourceAssignmentsRequest;
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourcesRepository.setAssignments(db, id, input.followIds)
        );
        if (!source) throw new HttpError(404, "Source not found");
        return { source };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.delete(
    "/api/sports/sources/:id",
    { schema: deleteSportsCustomSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const deleted = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourcesRepository.remove(db, id)
        );
        return { deleted };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
