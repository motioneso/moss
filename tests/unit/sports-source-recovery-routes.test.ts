import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import type { DatasetClient, GetDatasetOptions } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import {
  SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
  type SportsCustomSourceDto
} from "@moss/shared";

import {
  registerSportsRoutes,
  type SportsRoutesDependencies
} from "../../packages/sports/src/routes.js";

const actor: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-a"
};

function buildApp(sourceService: NonNullable<SportsRoutesDependencies["sourceService"]>) {
  const app = Fastify();
  registerSportsRoutes(app, {
    datasetClient: {
      async getDataset<T>(
        _key: string,
        _params: Record<string, unknown>,
        options: GetDatasetOptions<T>
      ) {
        return {
          data: options.fallback as T,
          degraded: false,
          fetchedAt: new Date().toISOString()
        };
      }
    } as DatasetClient,
    dataContext: {
      withDataContext: async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: async () => actor,
    repository: {
      list: async () => [],
      create: async (_db, input) => ({
        id: "follow-id",
        competitionKey: input.competitionKey,
        teamKey: input.teamKey ?? null,
        createdAt: "2026-08-24T00:00:00.000Z"
      }),
      remove: async () => false
    },
    now: () => new Date("2026-08-24T12:00:00.000Z"),
    discovery: {
      fetch: async () => ({ ok: false, reason: "network" }),
      ai: {
        generateJson: async () => ({ ok: false, error: "needs_config" }),
        fingerprint: async () => null
      }
    } as SportsRoutesDependencies["discovery"],
    storyFeedback: {
      refFor: () => "sports:test-ref",
      registerStories: async () => undefined
    },
    sourceService
  });
  return app;
}

describe("sports source recovery routes", () => {
  it("returns the normalized source list from the shared source service", async () => {
    const sources = [
      {
        kind: "builtin" as const,
        id: "espn" as const,
        label: "ESPN" as const,
        enabled: true,
        usesDefaultCoverage: true,
        assignments: []
      }
    ];
    const sourceService = {
      listSources: vi.fn(async () => sources)
    } as unknown as NonNullable<SportsRoutesDependencies["sourceService"]>;
    const app = buildApp(sourceService);
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/sports/sources" });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ sources });
    expect(sourceService.listSources).toHaveBeenCalledWith({});
    await app.close();
  });

  it("routes typed ESPN coverage through the shared source service", async () => {
    const source = {
      kind: "builtin" as const,
      id: "espn" as const,
      label: "ESPN" as const,
      enabled: true,
      usesDefaultCoverage: false,
      assignments: [{ kind: "sport" as const, sportKey: "soccer" as const }]
    };
    const sourceService = {
      replaceEspnCoverage: vi.fn(async () => source)
    } as unknown as NonNullable<SportsRoutesDependencies["sourceService"]>;
    const app = buildApp(sourceService);
    await app.ready();

    const response = await app.inject({
      method: "PUT",
      url: "/api/sports/sources/espn/coverage",
      payload: { assignments: source.assignments }
    });

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ source });
    expect(sourceService.replaceEspnCoverage).toHaveBeenCalledWith({}, source.assignments);
    await app.close();
  });

  it("routes Retry and recipe rebuild through the shared source service", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const source: SportsCustomSourceDto = {
      id,
      label: "Publisher",
      canonicalDomain: "publisher.example.com",
      homepageUrl: "https://publisher.example.com/",
      feedUrl: "https://publisher.example.com/feed.xml",
      retrievalMethod: "feed",
      enabled: true,
      healthState: "healthy",
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: "2026-08-24T12:00:00.000Z",
      lastSuccessAt: "2026-08-24T12:00:00.000Z",
      recipeStatus: "feed",
      assignedFollowIds: [],
      assignments: [],
      createdAt: "2026-08-21T00:00:00.000Z"
    };
    const preview = {
      status: "ok" as const,
      confirmationId: "confirmation-1",
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      candidate: {
        label: source.label,
        canonicalDomain: source.canonicalDomain,
        homepageUrl: source.homepageUrl,
        retrievalMethod: source.retrievalMethod,
        sampleCount: 0,
        confirmedFetchHosts: [source.canonicalDomain],
        sampleHeadlines: [],
        targets: []
      }
    };
    const sourceService = {
      retrySource: vi.fn(async () => source),
      previewRecipeRebuild: vi.fn(async () => preview),
      confirmRecipeRebuild: vi.fn(async () => source)
    } as unknown as NonNullable<SportsRoutesDependencies["sourceService"]>;
    const app = buildApp(sourceService);
    await app.ready();

    const retry = await app.inject({ method: "POST", url: `/api/sports/sources/${id}/retry` });
    expect(retry.statusCode).toBe(200);
    expect(JSON.parse(retry.body)).toEqual({ source });
    expect(sourceService.retrySource).toHaveBeenCalledWith(actor, id);

    const rebuildPreview = await app.inject({
      method: "POST",
      url: `/api/sports/sources/${id}/rebuild/preview`
    });
    expect(rebuildPreview.statusCode).toBe(200);
    expect(sourceService.previewRecipeRebuild).toHaveBeenCalledWith({}, actor.actorUserId, id);

    const rebuild = await app.inject({
      method: "PATCH",
      url: `/api/sports/sources/${id}/rebuild`,
      payload: {
        confirmationId: preview.confirmationId,
        authorizationAcknowledgement: preview.authorizationAcknowledgement,
        canonicalDomain: preview.candidate.canonicalDomain,
        confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
        targets: []
      }
    });
    expect(rebuild.statusCode).toBe(200);
    expect(sourceService.confirmRecipeRebuild).toHaveBeenCalledWith(
      {},
      actor.actorUserId,
      id,
      expect.objectContaining({ confirmationId: preview.confirmationId })
    );
    await app.close();
  });
});
