import { describe, expect, it } from "vitest";

import type { SportsCustomSourceDto } from "@moss/shared";
import { SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT } from "@moss/shared";

import type { SportsRoutesDependencies } from "../../packages/sports/src/routes.js";
import type { SportsSourcesRepository } from "../../packages/sports/src/source/repository.js";
import { makeSourcesRepo } from "./sports-sources-route-fixture.js";
import { buildApp, userA } from "./sports-routes.test.js";

describe("sports routes: custom sources", () => {
  it("POST /api/sports/sources/preview accepts a feed without a JSON model", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<rss><channel><item><title>A consequential sports headline</title><link>https://one.example.com/story</link></item></channel></rss>`,
          truncated: false
        }),
        ai: {
          generateJson: async () => ({ ok: false, error: "needs_config" }),
          fingerprint: async () => null
        }
      }
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources/preview",
      payload: { url: "https://one.example.com" }
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: "ok",
      candidate: { canonicalDomain: "one.example.com", retrievalMethod: "feed" }
    });
    await app.close();
  });

  it("previews, confirms, and persists a selected target with truthful health", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      discovery: {
        fetch: async (url) => ({
          ok: true,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: `<rss><channel><item><title>A consequential sports headline</title><link>https://one.example.com/story</link></item></channel></rss>`,
          truncated: false
        }),
        ai: {
          generateJson: async () => ({ ok: false, error: "needs_config" }),
          fingerprint: async () => null
        }
      }
    });
    await app.ready();
    const previewResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources/preview",
      payload: {
        url: "https://one.example.com",
        assignments: [
          {
            target: {
              kind: "follow",
              followId: "11111111-1111-1111-1111-111111111111"
            }
          }
        ]
      }
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = JSON.parse(previewResponse.body);
    expect(preview.candidate.targets).toEqual([
      expect.objectContaining({
        target: {
          kind: "follow",
          followId: "11111111-1111-1111-1111-111111111111"
        },
        label: "Dallas Cowboys",
        scope: "team",
        sampleHeadlines: ["A consequential sports headline"]
      })
    ]);

    const payload = {
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: preview.candidate.canonicalDomain,
      confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
      targets: preview.candidate.targets.map((target: { target: object; targetUrl: string }) => ({
        target: target.target,
        targetUrl: target.targetUrl
      }))
    };
    const confirmResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload
    });
    expect(confirmResponse.statusCode).toBe(201);
    expect(JSON.parse(confirmResponse.body).source).toMatchObject({
      healthState: "healthy",
      assignedFollowIds: ["11111111-1111-1111-1111-111111111111"],
      assignments: [
        {
          followId: "11111111-1111-1111-1111-111111111111",
          previewStatus: "verified",
          healthState: "healthy"
        }
      ]
    });
    expect(sourcesRepository.lockCount).toBe(1);

    const replayResponse = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload
    });
    expect(replayResponse.statusCode).toBe(409);
    await app.close();
  });

  it("POST /api/sports/sources confirms a preview and returns 400 at the source limit", async () => {
    const sourcesRepository = makeSourcesRepo([], true);
    const previews = {
      put: () => "confirmation-1",
      take: () => ({
        kind: "new-source" as const,
        ownerUserId: userA.actorUserId,
        submittedUrl: "https://publisher.example.com",
        candidate: {
          candidateId: "c1",
          label: "Publisher",
          canonicalDomain: "publisher.example.com",
          homepageUrl: "https://publisher.example.com/",
          feedUrl: "https://publisher.example.com/feed.xml",
          retrievalMethod: "feed" as const,
          sampleCount: 1,
          validationFingerprint: "fp",
          recipe: null,
          recipeFingerprint: null,
          confirmedFetchHosts: ["publisher.example.com"],
          targets: [],
          checkedAt: "2026-08-23T12:00:00.000Z",
          samples: [{ headline: "Headline" }]
        },
        duplicateOfSourceId: null,
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        createdAt: Date.now()
      })
    };
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      previews: previews as unknown as SportsRoutesDependencies["previews"]
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload: {
        confirmationId: "confirmation-1",
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        canonicalDomain: "publisher.example.com",
        confirmedFetchHosts: ["publisher.example.com"],
        targets: []
      }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("POST /api/sports/sources confirms a preview and assigns follows", async () => {
    const sourcesRepository = makeSourcesRepo([]);
    const previews = {
      put: () => "confirmation-1",
      take: () => ({
        kind: "new-source" as const,
        ownerUserId: userA.actorUserId,
        submittedUrl: "https://publisher.example.com",
        candidate: {
          candidateId: "c1",
          label: "Publisher",
          canonicalDomain: "publisher.example.com",
          homepageUrl: "https://publisher.example.com/",
          feedUrl: "https://publisher.example.com/feed.xml",
          retrievalMethod: "feed" as const,
          sampleCount: 1,
          validationFingerprint: "fp",
          recipe: null,
          recipeFingerprint: null,
          confirmedFetchHosts: ["publisher.example.com"],
          checkedAt: "2026-08-23T12:00:00.000Z",
          samples: [{ headline: "Headline" }],
          targets: [
            {
              target: {
                kind: "follow" as const,
                followId: "33333333-3333-3333-3333-333333333333"
              },
              label: "Dallas Cowboys",
              scope: "team" as const,
              targetUrl: "https://publisher.example.com/feed.xml",
              parameters: {},
              samples: [{ headline: "Headline" }],
              checkedAt: "2026-08-23T12:00:00.000Z"
            }
          ]
        },
        duplicateOfSourceId: null,
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        createdAt: Date.now()
      })
    };
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository,
      previews: previews as unknown as SportsRoutesDependencies["previews"]
    });
    await app.ready();
    const res = await app.inject({
      method: "POST",
      url: "/api/sports/sources",
      payload: {
        confirmationId: "confirmation-1",
        authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
        canonicalDomain: "publisher.example.com",
        confirmedFetchHosts: ["publisher.example.com"],
        targets: [
          {
            target: {
              kind: "follow",
              followId: "33333333-3333-3333-3333-333333333333"
            },
            targetUrl: "https://publisher.example.com/feed.xml"
          }
        ]
      }
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.source.assignedFollowIds).toEqual(["33333333-3333-3333-3333-333333333333"]);
    expect(sourcesRepository.assignments).toEqual([]);
    expect(sourcesRepository.lockCount).toBe(1);
    await app.close();
  });

  it("DELETE /api/sports/sources/:id removes a source", async () => {
    const source: SportsCustomSourceDto = {
      id: "11111111-1111-1111-1111-111111111111",
      label: "Publisher",
      canonicalDomain: "publisher.example.com",
      homepageUrl: "https://publisher.example.com/",
      feedUrl: null,
      retrievalMethod: "scrape",
      enabled: true,
      healthState: "pending",
      healthReasonCode: null,
      healthMessage: null,
      lastCheckedAt: null,
      lastSuccessAt: null,
      recipeStatus: "ready",
      photoStatus: "pending",
      photosFoundByMoss: false,
      assignedFollowIds: [],
      assignments: [],
      createdAt: "2026-08-21T00:00:00.000Z"
    };
    const sourcesRepository = makeSourcesRepo([source]);
    const { app } = buildApp({
      sourcesRepository: sourcesRepository as unknown as SportsSourcesRepository
    });
    await app.ready();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/sports/sources/11111111-1111-1111-1111-111111111111"
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ deleted: true });
    expect(sourcesRepository.removed).toEqual(["11111111-1111-1111-1111-111111111111"]);
    await app.close();
  });
});
