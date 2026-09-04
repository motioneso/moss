import type { FastifyInstance, FastifyRequest } from "fastify";

import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextRunner, PreferencesPort } from "@moss/db";
import { HttpError, handleRouteError } from "@moss/module-sdk";
import type { NewsAiPort } from "@moss/news";
import {
  confirmSportsSourceSchema,
  createSportsFollowResponseSchema,
  deleteSportsCustomSourceSchema,
  deleteSportsFollowResponseSchema,
  previewSportsSourceSchema,
  previewSportsSourceAssignmentsSchema,
  previewSportsSourceRecipeSchema,
  retrySportsSourceSchema,
  sportsCatalogResponseSchema,
  sportsNewsSourcesResponseSchema,
  sportsFollowsResponseSchema,
  sportsLeagueTeamsResponseSchema,
  sportsOverviewResponseSchema,
  sportsStandingsPreferencesResponseSchema,
  sportsStandingsResponseSchema,
  sportsTeamSearchResponseSchema,
  updateSportsSourceAssignmentsSchema,
  updateSportsEspnCoverageSchema,
  updateSportsStandingsPreferencesSchema,
  updateSportsSourceRecipeSchema,
  type ConfirmSportsSourceRecipeRequest,
  type ConfirmSportsSourceRequest,
  type ConfirmSportsSourceAssignmentsRequest,
  type CreateSportsFollowRequest,
  type PreviewSportsSourceRequest,
  type PreviewSportsSourceAssignmentsRequest,
  type UpdateSportsEspnCoverageRequest
} from "@moss/shared";
import { PreferencesRepository } from "@moss/structured-state";

import { SportsFollowsRepository } from "./repository.js";
import {
  SportsService,
  type SportsFollowsWriter,
  type SportsStoryFeedbackPort,
  type SportsStoryRelevancePort
} from "./sports-service.js";
import { SPORTS_CATALOG, catalogEntry } from "./source/catalog.js";
import { type SportsDiscoveryBrowserPort, type SportsSafeFetchPort } from "./source/discovery.js";
import { SportsEspnCoverageRepository } from "./source/espn-coverage-repository.js";
import { registerSportsSourceIconRoute, type SportsIconFetchPort } from "./source/icon-route.js";
import { SportsSourcesRepository } from "./source/repository.js";
import type { SportsPublicSourceReader } from "./source/public-source-reader.js";
import { createSportsPreviewStore } from "./source/preview-store.js";
import { SportsSourceRequestError, SportsSourceService } from "./source/service.js";

type SportsSourcePreviewStore = ReturnType<typeof createSportsPreviewStore>;
const STANDINGS_PREFERENCES_KEY = "sports.standings_competition_keys";

function parseStandingsPreferences(body: unknown): readonly string[] {
  if (
    body === null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    !("selectedCompetitionKeys" in body)
  ) {
    throw new HttpError(400, "Invalid standings preferences");
  }
  const keys = body.selectedCompetitionKeys;
  if (
    !Array.isArray(keys) ||
    keys.length > 64 ||
    keys.some((key) => typeof key !== "string") ||
    new Set(keys).size !== keys.length
  ) {
    throw new HttpError(400, "Invalid standings competition keys");
  }
  return keys as readonly string[];
}

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
  readonly preferencesRepository?: PreferencesPort;
  /** Clock seam forwarded to the service (default `() => new Date()`). */
  readonly now?: () => Date;
  /** #1572 custom source discovery — required for the preview/confirm/list/assign/delete routes. */
  readonly discovery: {
    readonly fetch: SportsSafeFetchPort;
    readonly ai: NewsAiPort;
    readonly browser?: SportsDiscoveryBrowserPort;
    /** #2211 byte fetch for publication favicons; absent means every icon lookup is a miss. */
    readonly fetchBytes?: SportsIconFetchPort;
  };
  /** Optional injection point for tests; defaults to a real `SportsSourcesRepository`. */
  readonly sourcesRepository?: SportsSourcesRepository;
  readonly espnCoverageRepository?: SportsEspnCoverageRepository;
  readonly publicSourceReader?: Pick<SportsPublicSourceReader, "refresh">;
  /** Story relevance feedback is required on the live route so story references reach the browser. */
  readonly storyRelevance?: SportsStoryRelevancePort;
  readonly storyFeedback: SportsStoryFeedbackPort;
  readonly sourceService?: SportsSourceService;
  /** Optional injection point for tests; defaults to a private in-memory store. */
  readonly previews?: SportsSourcePreviewStore;
}

export function registerSportsRoutes(
  server: FastifyInstance,
  dependencies: SportsRoutesDependencies
): void {
  const repository: SportsFollowsWriter = dependencies.repository ?? new SportsFollowsRepository();
  const preferencesRepository = dependencies.preferencesRepository ?? new PreferencesRepository();
  const sourcesRepository = dependencies.sourcesRepository ?? new SportsSourcesRepository();
  const espnCoverageRepository =
    dependencies.espnCoverageRepository ?? new SportsEspnCoverageRepository();
  const service = new SportsService({
    datasetClient: dependencies.datasetClient,
    dataContext: dependencies.dataContext,
    repository,
    espnCoverage: espnCoverageRepository,
    now: dependencies.now,
    publicSourceReader: dependencies.publicSourceReader,
    ...(dependencies.storyRelevance ? { storyRelevance: dependencies.storyRelevance } : {}),
    storyFeedback: dependencies.storyFeedback
  });
  const previews = dependencies.previews ?? createSportsPreviewStore();
  const sourceService =
    dependencies.sourceService ??
    new SportsSourceService({
      follows: repository,
      sources: sourcesRepository,
      espnCoverage: espnCoverageRepository,
      previews,
      discovery: dependencies.discovery,
      resolveTeams: async (competitionKey) => (await service.getLeagueTeams(competitionKey)).teams,
      dataContext: dependencies.dataContext,
      reader: dependencies.publicSourceReader
    });

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
    "/api/sports/standings-preferences",
    { schema: sportsStandingsPreferencesResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const stored = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          preferencesRepository.get(db, STANDINGS_PREFERENCES_KEY)
        );
        if (!Array.isArray(stored)) return { selectedCompetitionKeys: null };
        const selected = new Set(stored.filter((key): key is string => typeof key === "string"));
        return {
          selectedCompetitionKeys: SPORTS_CATALOG.map((entry) => entry.competitionKey).filter(
            (key) => selected.has(key)
          )
        };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  server.put(
    "/api/sports/standings-preferences",
    { schema: { response: updateSportsStandingsPreferencesSchema.response } },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = parseStandingsPreferences(request.body);
        const requested = new Set(input);
        if (input.some((key) => !catalogEntry(key))) {
          throw new HttpError(400, "Standings preferences contain an unknown competition");
        }
        const selectedCompetitionKeys = SPORTS_CATALOG.map((entry) => entry.competitionKey).filter(
          (key) => requested.has(key)
        );
        await dependencies.dataContext.withDataContext(accessContext, (db) =>
          preferencesRepository.upsert(db, STANDINGS_PREFERENCES_KEY, selectedCompetitionKeys)
        );
        return { selectedCompetitionKeys };
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
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        request.raw.once("aborted", abort);
        try {
          return await service.getOverview(accessContext, controller.signal);
        } finally {
          request.raw.off("aborted", abort);
        }
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
    { schema: sportsNewsSourcesResponseSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const sources = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.listSources(db)
        );
        return { sources };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );

  registerSportsSourceIconRoute(server, {
    dataContext: dependencies.dataContext,
    resolveAccessContext: dependencies.resolveAccessContext,
    repository: sourcesRepository,
    fetchBytes:
      dependencies.discovery.fetchBytes ?? (async () => ({ ok: false, reason: "blocked" })),
    now: dependencies.now
  });

  server.put(
    "/api/sports/sources/espn/coverage",
    { schema: updateSportsEspnCoverageSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const input = request.body as UpdateSportsEspnCoverageRequest;
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.replaceEspnCoverage(db, input.assignments)
        );
        return { source };
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
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
        return await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.previewNewSource(db, accessContext.actorUserId, input)
        );
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
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.confirmNewSource(db, accessContext.actorUserId, input)
        );
        reply.code(201);
        return { source };
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
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
        const input = request.body as ConfirmSportsSourceAssignmentsRequest;
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.confirmAssignments(db, accessContext.actorUserId, id, input)
        );
        return { source };
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/sources/:id/assignments/preview",
    { schema: previewSportsSourceAssignmentsSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const input = request.body as PreviewSportsSourceAssignmentsRequest;
        return await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.previewAssignments(db, accessContext.actorUserId, id, input)
        );
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/sources/:id/retry",
    { schema: retrySportsSourceSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        return { source: await sourceService.retrySource(accessContext, id) };
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.post(
    "/api/sports/sources/:id/rebuild/preview",
    { schema: previewSportsSourceRecipeSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        return await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.previewRecipeRebuild(db, accessContext.actorUserId, id)
        );
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
        return handleRouteError(error, reply);
      }
    }
  );

  server.patch(
    "/api/sports/sources/:id/rebuild",
    { schema: updateSportsSourceRecipeSchema },
    async (request, reply) => {
      try {
        const accessContext = await dependencies.resolveAccessContext(request);
        const { id } = request.params as { id: string };
        const input = request.body as ConfirmSportsSourceRecipeRequest;
        const source = await dependencies.dataContext.withDataContext(accessContext, (db) =>
          sourceService.confirmRecipeRebuild(db, accessContext.actorUserId, id, input)
        );
        return { source };
      } catch (error) {
        if (error instanceof SportsSourceRequestError) {
          return handleRouteError(new HttpError(error.statusCode, error.message), reply);
        }
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
          sourceService.removeSource(db, id)
        );
        return { deleted };
      } catch (error) {
        return handleRouteError(error, reply);
      }
    }
  );
}
