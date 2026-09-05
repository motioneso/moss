import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import {
  SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
  type SportsFollowDto,
  type SportsSourceAssignmentTarget
} from "@moss/shared";

import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import { createSportsPreviewStore } from "../../packages/sports/src/source/preview-store.js";
import { validateSportsSourceRecipe } from "../../packages/sports/src/source/recipe.js";
import type {
  SportsSourceBaseline,
  SportsSourcesRepository
} from "../../packages/sports/src/source/repository.js";
import { SportsSourceService } from "../../packages/sports/src/source/service.js";

const followId = "11111111-1111-1111-1111-111111111111";
const sourceId = "22222222-2222-2222-2222-222222222222";
const assignmentId = "33333333-3333-3333-3333-333333333333";
const addedFollowId = "44444444-4444-4444-4444-444444444444";
const checkedAt = "2026-08-23T12:00:00.000Z";

const baseline: SportsSourceBaseline = {
  source: {
    id: sourceId,
    label: "Publisher",
    canonicalDomain: "publisher.example.com",
    homepageUrl: "https://publisher.example.com/",
    feedUrl: "https://publisher.example.com/feed.xml",
    retrievalMethod: "feed",
    enabled: true,
    healthState: "healthy",
    healthReasonCode: null,
    healthMessage: null,
    lastCheckedAt: checkedAt,
    lastSuccessAt: checkedAt,
    recipeStatus: "feed",
    photoStatus: "pending",
    photosFoundByMoss: false,
    assignedFollowIds: [followId],
    assignments: [
      {
        id: assignmentId,
        followId,
        sportKey: null,
        targetUrl: "https://publisher.example.com/feed.xml",
        previewStatus: "verified",
        healthState: "healthy",
        healthReasonCode: null,
        healthMessage: null,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        createdAt: checkedAt
      }
    ],
    createdAt: checkedAt
  },
  validationFingerprint: "feed-fingerprint",
  recipeJson: null,
  recipeFingerprint: null,
  confirmedFetchHosts: ["publisher.example.com"],
  updatedAt: checkedAt,
  assignments: [
    {
      id: assignmentId,
      followId,
      sportKey: null,
      targetUrl: "https://publisher.example.com/feed.xml",
      parameters: {},
      previewStatus: "verified"
    }
  ]
};

function setup(
  currentBaseline: SportsSourceBaseline = baseline,
  follows: SportsFollowDto[] = [
    {
      id: followId,
      competitionKey: "nfl",
      teamKey: "dal",
      sourceTeamId: "id-dal",
      createdAt: checkedAt
    }
  ],
  teams = [
    {
      teamKey: "dal",
      competitionKey: "nfl",
      name: "Dallas Cowboys",
      shortName: "DAL",
      crestUrl: null,
      sourceTeamId: "id-dal"
    },
    {
      teamKey: "phi",
      competitionKey: "nfl",
      name: "Philadelphia Eagles",
      shortName: "PHI",
      crestUrl: null,
      sourceTeamId: "id-phi"
    }
  ]
) {
  const replaceAssignments = vi.fn(async () => baseline.source);
  const fetch = vi.fn<SportsSafeFetchPort>(async () => ({
    ok: false as const,
    reason: "network" as const
  }));
  const sources = {
    list: vi.fn(async () => [baseline.source]),
    getBaseline: vi.fn(async () => currentBaseline),
    lockOwnerAssignments: vi.fn(async () => undefined),
    countAssignments: vi.fn(async () => 1),
    replaceScopeAssignments: replaceAssignments
  } as unknown as SportsSourcesRepository;
  const service = new SportsSourceService({
    follows: {
      list: async () => follows
    },
    sources,
    espnCoverage: {
      get: async () => ({ enabled: true, usesDefaultCoverage: true, assignments: [] }),
      replace: async (_db: DataContextDb, targets: readonly SportsSourceAssignmentTarget[]) => ({
        enabled: targets.length > 0,
        usesDefaultCoverage: false,
        assignments: targets
      })
    },
    previews: createSportsPreviewStore(),
    discovery: {
      fetch,
      ai: {
        generateJson: async () => ({ ok: false as const, error: "needs_config" as const }),
        fingerprint: async () => null
      }
    },
    resolveTeams: async () => teams
  });
  return { service, fetch, replaceAssignments };
}

async function confirm(
  service: SportsSourceService,
  db: DataContextDb,
  preview: Awaited<ReturnType<SportsSourceService["previewAssignments"]>>
) {
  if (!preview.confirmationId || !preview.candidate || !preview.authorizationAcknowledgement) {
    throw new Error("expected successful assignment preview");
  }
  return service.confirmAssignments(db, "owner-1", sourceId, {
    confirmationId: preview.confirmationId,
    authorizationAcknowledgement: preview.authorizationAcknowledgement,
    canonicalDomain: preview.candidate.canonicalDomain,
    confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
    targets: preview.candidate.targets.map((target) => ({
      target: target.target,
      targetUrl: target.targetUrl
    }))
  });
}

describe("SportsSourceService assignment replacement", () => {
  it("lists ESPN first followed by custom publishers", async () => {
    const { service } = setup();
    await expect(service.listSources({} as DataContextDb)).resolves.toEqual([
      {
        kind: "builtin",
        id: "espn",
        label: "ESPN",
        enabled: true,
        usesDefaultCoverage: true,
        assignments: []
      },
      { kind: "custom", ...baseline.source }
    ]);
  });

  it("confirms removals-only without an external request", async () => {
    const { service, fetch, replaceAssignments } = setup();
    const db = {} as DataContextDb;
    const preview = await service.previewAssignments(db, "owner-1", sourceId, {
      assignments: []
    });

    expect(preview).toMatchObject({
      status: "ok",
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      candidate: { targets: [] }
    });
    await confirm(service, db, preview);
    expect(fetch).not.toHaveBeenCalled();
    expect(replaceAssignments).toHaveBeenCalledWith(db, sourceId, [], []);
  });

  it("reuses the unchanged verified assignment identity and health", async () => {
    const { service, fetch, replaceAssignments } = setup();
    const db = {} as DataContextDb;
    const preview = await service.previewAssignments(db, "owner-1", sourceId, {
      assignments: [{ target: { kind: "follow", followId } }]
    });
    const source = await confirm(service, db, preview);

    expect(fetch).not.toHaveBeenCalled();
    expect(replaceAssignments).toHaveBeenCalledWith(db, sourceId, [assignmentId], []);
    expect(source.assignments[0]).toMatchObject({
      id: assignmentId,
      healthState: "healthy",
      lastCheckedAt: checkedAt,
      lastSuccessAt: checkedAt
    });
  });

  it("previews and confirms a sport target without inventing a follow id", async () => {
    const feedUrl = "https://publisher.example.com/feed.xml";
    const { service, fetch, replaceAssignments } = setup({
      ...baseline,
      validationFingerprint: createHash("sha256").update(feedUrl).digest("hex")
    });
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      finalUrl: feedUrl,
      contentType: "application/rss+xml",
      body: "<rss><channel><item><title>Soccer story</title></item></channel></rss>",
      truncated: false
    });
    const db = {} as DataContextDb;
    const preview = await service.previewAssignments(db, "owner-1", sourceId, {
      assignments: [
        { target: { kind: "follow", followId } },
        { target: { kind: "sport", sportKey: "soccer" } }
      ]
    });

    expect(preview).toMatchObject({
      status: "ok",
      candidate: {
        targets: [
          { target: { kind: "follow", followId } },
          {
            target: { kind: "sport", sportKey: "soccer" },
            label: "Soccer",
            scope: "sport",
            targetUrl: feedUrl
          }
        ]
      }
    });
    await confirm(service, db, preview);
    expect(replaceAssignments).toHaveBeenCalledWith(
      db,
      sourceId,
      [assignmentId],
      [expect.objectContaining({ target: { kind: "sport", sportKey: "soccer" } })]
    );
  });

  it("previews Soccer while retaining the production-shaped FotMob assignments", async () => {
    const feedUrl = "https://www.fotmob.com/topnews/feed?format=atom";
    const retained = [
      { id: "760afbd3-2a5a-426a-b753-7490fa22b289", competitionKey: "usa.1", teamKey: "sd" },
      { id: "65728b2d-843f-4d54-a69f-ddd2fb788ed5", competitionKey: "eng.1", teamKey: "liv" },
      {
        id: "f51b7138-b406-4216-a789-8cf246debaf2",
        competitionKey: "uefa.champions",
        teamKey: null
      },
      {
        id: "7893b2d6-c4f5-40a7-ae71-fe9e613fd633",
        competitionKey: "fifa.world",
        teamKey: "usa"
      }
    ].map((follow) => ({
      ...follow,
      sourceTeamId: follow.teamKey === null ? null : `id-${follow.teamKey}`,
      createdAt: checkedAt
    }));
    const fotmob: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        label: "FotMob - Football Live Scores",
        canonicalDomain: "www.fotmob.com",
        homepageUrl: "https://www.fotmob.com/",
        feedUrl,
        assignedFollowIds: retained.map(({ id }) => id),
        assignments: retained.map(({ id }, index) => ({
          ...baseline.source.assignments[0]!,
          id: `0c4ab51b-7829-44b4-860a-b2764aa0d5f${index}`,
          followId: id,
          targetUrl: feedUrl
        }))
      },
      validationFingerprint: "3cbe67830bfc90ce81369b2967871c241984c2d1ba52f69cb5fdd1fd48e6875c",
      confirmedFetchHosts: ["www.fotmob.com"],
      assignments: retained.map(({ id }, index) => ({
        ...baseline.assignments[0]!,
        id: `0c4ab51b-7829-44b4-860a-b2764aa0d5f${index}`,
        followId: id,
        targetUrl: feedUrl
      }))
    };
    const { service, fetch, replaceAssignments } = setup(fotmob, retained, [
      {
        teamKey: "sd",
        competitionKey: "usa.1",
        name: "San Diego FC",
        shortName: "SDFC",
        crestUrl: null,
        sourceTeamId: "id-sd"
      },
      {
        teamKey: "liv",
        competitionKey: "eng.1",
        name: "Liverpool",
        shortName: "LIV",
        crestUrl: null,
        sourceTeamId: "id-liv"
      },
      {
        teamKey: "usa",
        competitionKey: "fifa.world",
        name: "USA",
        shortName: "USA",
        crestUrl: null,
        sourceTeamId: "id-usa"
      }
    ]);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      finalUrl: feedUrl,
      contentType: "application/atom+xml",
      body: "<feed><entry><title>Soccer story</title></entry></feed>",
      truncated: false
    });

    const preview = await service.previewAssignments({} as DataContextDb, "owner-1", sourceId, {
      assignments: [
        ...retained.map(({ id }) => ({ target: { kind: "follow" as const, followId: id } })),
        { target: { kind: "sport", sportKey: "soccer" } }
      ]
    });

    expect(preview.status).toBe("ok");
    expect(preview.confirmationId).toBeTruthy();
    expect(preview.candidate?.targets.map(({ target }) => target)).toEqual([
      ...retained.map(({ id }) => ({ kind: "follow", followId: id })),
      { kind: "sport", sportKey: "soccer" }
    ]);
    expect(replaceAssignments).not.toHaveBeenCalled();
  });

  it("maps an added assignment with the persisted recipe and exact saved hosts", async () => {
    const recipe = {
      version: 1,
      kind: "json",
      fetchHosts: ["publisher.example.com"],
      request: {
        urlTemplate: "https://publisher.example.com/api/team/{teamId}/news",
        slots: [{ name: "teamId", location: "path", encoding: "path_segment", maxLength: 16 }],
        headers: { accept: "application/json" }
      },
      scopes: ["team"],
      itemLimit: 10,
      extraction: {
        itemsPath: ["news"],
        headlinePath: ["title"],
        normalize: ["trim"]
      }
    } as const;
    const validated = validateSportsSourceRecipe(recipe);
    if (!validated.ok) throw new Error("expected valid fixture recipe");
    const recipeBaseline: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        feedUrl: null,
        retrievalMethod: "scrape",
        recipeStatus: "ready",
        photoStatus: "pending",
        photosFoundByMoss: false,
        assignments: baseline.source.assignments.map((assignment) => ({
          ...assignment,
          targetUrl: "https://publisher.example.com/api/team/DAL/news"
        }))
      },
      validationFingerprint: validated.fingerprint,
      recipeJson: recipe,
      recipeFingerprint: validated.fingerprint,
      assignments: baseline.assignments.map((assignment) => ({
        ...assignment,
        targetUrl: "https://publisher.example.com/api/team/DAL/news",
        parameters: { teamId: "DAL" }
      }))
    };
    const generateJson = vi.fn(async () => ({
      ok: true as const,
      object: { targets: [{ targetKey: `follow:${addedFollowId}`, parameters: { teamId: "42" } }] }
    }));
    const fetch = vi.fn(async (url: string, options?: { allowedHosts?: readonly string[] }) => {
      if (url === "https://publisher.example.com/") {
        return {
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: "text/html",
          body: "<title>Publisher</title>",
          truncated: false
        };
      }
      if (url === "https://publisher.example.com/api/team/42/news") {
        return {
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: "application/json",
          body: JSON.stringify({ news: [{ title: "A persisted recipe headline" }] }),
          truncated: false
        };
      }
      return { ok: false as const, reason: "network" as const };
    });
    const service = new SportsSourceService({
      follows: {
        list: async () => [
          {
            id: followId,
            competitionKey: "nfl",
            teamKey: "dal",
            sourceTeamId: "id-dal",
            createdAt: checkedAt
          },
          {
            id: addedFollowId,
            competitionKey: "nfl",
            teamKey: "phi",
            sourceTeamId: "id-phi",
            createdAt: checkedAt
          }
        ]
      },
      sources: {
        getBaseline: async () => recipeBaseline
      } as unknown as SportsSourcesRepository,
      previews: createSportsPreviewStore(),
      discovery: {
        fetch,
        ai: { fingerprint: async () => null, generateJson }
      },
      resolveTeams: async () => [
        {
          teamKey: "dal",
          competitionKey: "nfl",
          name: "Dallas Cowboys",
          shortName: "DAL",
          crestUrl: null,
          sourceTeamId: "id-dal"
        },
        {
          teamKey: "phi",
          competitionKey: "nfl",
          name: "Philadelphia Eagles",
          shortName: "PHI",
          crestUrl: null,
          sourceTeamId: "id-phi"
        }
      ]
    });

    const preview = await service.previewAssignments({} as DataContextDb, "owner-1", sourceId, {
      assignments: [
        { target: { kind: "follow", followId } },
        { target: { kind: "follow", followId: addedFollowId } }
      ]
    });

    expect(preview).toMatchObject({
      status: "ok",
      candidate: {
        targets: [
          {
            target: { kind: "follow", followId },
            targetUrl: "https://publisher.example.com/api/team/DAL/news"
          },
          {
            target: { kind: "follow", followId: addedFollowId },
            targetUrl: "https://publisher.example.com/api/team/42/news",
            sampleHeadlines: ["A persisted recipe headline"]
          }
        ]
      }
    });
    expect(generateJson).toHaveBeenCalledOnce();
    expect(generateJson).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: expect.stringContaining("FIXED_RECIPE_START") })
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [, options] of fetch.mock.calls) {
      expect(options?.allowedHosts).toEqual(["publisher.example.com"]);
    }
  });

  it("retains all persisted feed hosts while previewing an added assignment", async () => {
    const feedBaseline: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        canonicalDomain: "publisher.com",
        homepageUrl: "https://www.publisher.com/",
        feedUrl: "https://feeds.publisher.com/rss.xml",
        assignments: baseline.source.assignments.map((assignment) => ({
          ...assignment,
          targetUrl: "https://feeds.publisher.com/rss.xml"
        }))
      },
      validationFingerprint: createHash("sha256")
        .update("https://feeds.publisher.com/rss.xml")
        .digest("hex"),
      confirmedFetchHosts: ["www.publisher.com", "feeds.publisher.com"],
      assignments: baseline.assignments.map((assignment) => ({
        ...assignment,
        targetUrl: "https://feeds.publisher.com/rss.xml"
      }))
    };
    const { service, fetch } = setup(feedBaseline, [
      {
        id: followId,
        competitionKey: "nfl",
        teamKey: "dal",
        sourceTeamId: "id-dal",
        createdAt: checkedAt
      },
      {
        id: addedFollowId,
        competitionKey: "nfl",
        teamKey: "phi",
        sourceTeamId: "id-phi",
        createdAt: checkedAt
      }
    ]);
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      finalUrl: "https://feeds.publisher.com/rss.xml",
      contentType: "application/rss+xml",
      body: "<rss><channel><title>Publisher</title></channel></rss>",
      truncated: false
    });

    const preview = await service.previewAssignments({} as DataContextDb, "owner-1", sourceId, {
      assignments: [
        { target: { kind: "follow", followId } },
        { target: { kind: "follow", followId: addedFollowId } }
      ]
    });

    expect(preview).toMatchObject({
      status: "ok",
      candidate: {
        confirmedFetchHosts: ["www.publisher.com", "feeds.publisher.com"],
        targets: [
          {
            target: { kind: "follow", followId },
            targetUrl: "https://feeds.publisher.com/rss.xml"
          },
          {
            target: { kind: "follow", followId: addedFollowId },
            targetUrl: "https://feeds.publisher.com/rss.xml"
          }
        ]
      }
    });
    expect(fetch).toHaveBeenCalledWith("https://feeds.publisher.com/rss.xml", {
      allowedHosts: ["www.publisher.com", "feeds.publisher.com"]
    });
  });
});

describe("SportsSourceService recipe recovery", () => {
  function rebuildService(currentBaseline: SportsSourceBaseline = baseline) {
    const replaceRecipe = vi.fn(async () => currentBaseline.source);
    const getBaseline = vi.fn(async () => currentBaseline);
    const fetch = vi.fn(async (url: string) => ({
      ok: true as const,
      status: 200,
      finalUrl: url,
      contentType: "application/rss+xml",
      body: "<rss><channel><title>Publisher</title></channel></rss>",
      truncated: false
    }));
    const service = new SportsSourceService({
      follows: {
        list: async () => [
          {
            id: followId,
            competitionKey: "nfl",
            teamKey: "dal",
            sourceTeamId: "id-dal",
            createdAt: checkedAt
          }
        ]
      },
      sources: {
        getBaseline,
        lockOwnerAssignments: vi.fn(async () => undefined),
        replaceRecipe
      } as unknown as SportsSourcesRepository,
      previews: createSportsPreviewStore(),
      discovery: {
        fetch,
        ai: {
          generateJson: async () => ({ ok: false as const, error: "needs_config" as const }),
          fingerprint: async () => null
        }
      },
      resolveTeams: async () => [
        {
          teamKey: "dal",
          competitionKey: "nfl",
          name: "Dallas Cowboys",
          shortName: "DAL",
          crestUrl: null,
          sourceTeamId: "id-dal"
        }
      ]
    });
    return { service, fetch, getBaseline, replaceRecipe };
  }

  it("previews and confirms a complete actor-bound rebuild", async () => {
    const { service, replaceRecipe } = rebuildService();
    const db = {} as DataContextDb;
    const preview = await service.previewRecipeRebuild(db, "owner-1", sourceId);
    if (!preview.confirmationId || !preview.candidate || !preview.authorizationAcknowledgement) {
      throw new Error("expected successful recipe preview");
    }

    const source = await service.confirmRecipeRebuild(db, "owner-1", sourceId, {
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: preview.candidate.canonicalDomain,
      confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
      targets: preview.candidate.targets.map((target) => ({
        target: target.target,
        targetUrl: target.targetUrl
      }))
    });

    expect(source).toBe(baseline.source);
    expect(replaceRecipe).toHaveBeenCalledWith(
      db,
      sourceId,
      expect.objectContaining({
        canonicalDomain: baseline.source.canonicalDomain,
        retrievalMethod: "feed",
        targets: [expect.objectContaining({ target: { kind: "follow", followId } })]
      })
    );
  });

  it("adds coverage to a subreddit source without calling Reddit", async () => {
    // #2211 (Ben, 2026-09-04): editing coverage on r/buffalobills right after adding it hit
    // Reddit's rate limit. Every subreddit target reads the one stored feed, so no fetch is needed.
    const feedUrl = "https://www.reddit.com/r/buffalobills/hot.rss";
    const redditBaseline: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        label: "r/buffalobills",
        canonicalDomain: "reddit.com",
        homepageUrl: "https://www.reddit.com/r/buffalobills/",
        feedUrl,
        retrievalMethod: "reddit",
        assignedFollowIds: [],
        assignments: []
      },
      confirmedFetchHosts: ["www.reddit.com"],
      assignments: []
    };
    const { service, fetch, replaceAssignments } = setup(redditBaseline);
    const db = {} as DataContextDb;
    const preview = await service.previewAssignments(db, "owner-1", sourceId, {
      assignments: [{ target: { kind: "sport", sportKey: "football" } }]
    });

    expect(preview).toMatchObject({
      status: "ok",
      candidate: {
        retrievalMethod: "reddit",
        targets: [{ target: { kind: "sport", sportKey: "football" }, targetUrl: feedUrl }]
      }
    });
    await confirm(service, db, preview);
    expect(fetch).not.toHaveBeenCalled();
    expect(replaceAssignments).toHaveBeenCalledWith(
      db,
      sourceId,
      [],
      [expect.objectContaining({ targetUrl: feedUrl })]
    );
  });

  it("rebuilds a legacy apex source when discovery resolves its www host", async () => {
    const legacyBaseline: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        canonicalDomain: "publisher.example.com",
        homepageUrl: "https://www.publisher.example.com/",
        feedUrl: null,
        retrievalMethod: "scrape"
      }
    };
    const { service } = rebuildService(legacyBaseline);

    await expect(
      service.previewRecipeRebuild({} as DataContextDb, "owner-1", sourceId)
    ).resolves.toMatchObject({
      status: "ok",
      candidate: {
        canonicalDomain: "publisher.example.com",
        confirmedFetchHosts: ["www.publisher.example.com"]
      }
    });
  });

  it("keeps the saved canonical domain through a full rebuild-and-confirm when discovery resolves the www host, even though another source already owns it", async () => {
    const staleBaseline: SportsSourceBaseline = {
      ...baseline,
      source: {
        ...baseline.source,
        canonicalDomain: "fotmob.com",
        homepageUrl: "https://www.fotmob.com/",
        feedUrl: null,
        retrievalMethod: "scrape",
        recipeStatus: "missing"
      },
      confirmedFetchHosts: ["www.fotmob.com"]
    };
    // A second source already owns www.fotmob.com. replaceRecipe is the real repository method's
    // stand-in: it mirrors the write it performs and would violate
    // sports_custom_sources_owner_user_id_canonical_domain_key against that row if the rebuilt
    // candidate's canonicalDomain were ever allowed to drift from the baseline's.
    let persisted = staleBaseline.source;
    const replaceRecipe = vi.fn(async (_db: DataContextDb, _id: string, candidate) => {
      persisted = {
        ...persisted,
        canonicalDomain: candidate.canonicalDomain,
        homepageUrl: candidate.homepageUrl,
        feedUrl: candidate.feedUrl,
        retrievalMethod: candidate.retrievalMethod,
        recipeStatus: candidate.retrievalMethod === "feed" ? "feed" : "ready"
      };
      return persisted;
    });
    const getBaseline = vi.fn(async () => staleBaseline);
    const fetch = vi.fn(async (url: string) => ({
      ok: true as const,
      status: 200,
      finalUrl: url,
      contentType: "application/rss+xml",
      body: "<rss><channel><title>Publisher</title></channel></rss>",
      truncated: false
    }));
    const service = new SportsSourceService({
      follows: {
        list: async () => [
          {
            id: followId,
            competitionKey: "nfl",
            teamKey: "dal",
            sourceTeamId: "id-dal",
            createdAt: checkedAt
          }
        ]
      },
      sources: {
        getBaseline,
        lockOwnerAssignments: vi.fn(async () => undefined),
        replaceRecipe
      } as unknown as SportsSourcesRepository,
      previews: createSportsPreviewStore(),
      discovery: {
        fetch,
        ai: {
          generateJson: async () => ({ ok: false as const, error: "needs_config" as const }),
          fingerprint: async () => null
        }
      },
      resolveTeams: async () => [
        {
          teamKey: "dal",
          competitionKey: "nfl",
          name: "Dallas Cowboys",
          shortName: "DAL",
          crestUrl: null,
          sourceTeamId: "id-dal"
        }
      ]
    });
    const db = {} as DataContextDb;

    const preview = await service.previewRecipeRebuild(db, "owner-1", sourceId);
    if (!preview.confirmationId || !preview.candidate || !preview.authorizationAcknowledgement) {
      throw new Error("expected successful recipe preview");
    }
    expect(preview.candidate.canonicalDomain).toBe("fotmob.com");

    const source = await service.confirmRecipeRebuild(db, "owner-1", sourceId, {
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: preview.candidate.canonicalDomain,
      confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
      targets: preview.candidate.targets.map((target) => ({
        target: target.target,
        targetUrl: target.targetUrl
      }))
    });

    expect(replaceRecipe).toHaveBeenCalledWith(
      db,
      sourceId,
      expect.objectContaining({ canonicalDomain: "fotmob.com" })
    );
    expect(source.canonicalDomain).toBe("fotmob.com");
    expect(source.retrievalMethod).toBe("feed");
    expect(source.recipeStatus).toBe("feed");
  });

  it("rejects confirmation after the source baseline changes", async () => {
    const { service, getBaseline, replaceRecipe } = rebuildService();
    const db = {} as DataContextDb;
    const preview = await service.previewRecipeRebuild(db, "owner-1", sourceId);
    if (!preview.confirmationId || !preview.candidate || !preview.authorizationAcknowledgement) {
      throw new Error("expected successful recipe preview");
    }
    getBaseline.mockResolvedValueOnce({ ...baseline, updatedAt: "2026-08-24T00:00:00.000Z" });

    await expect(
      service.confirmRecipeRebuild(db, "owner-1", sourceId, {
        confirmationId: preview.confirmationId,
        authorizationAcknowledgement: preview.authorizationAcknowledgement,
        canonicalDomain: preview.candidate.canonicalDomain,
        confirmedFetchHosts: preview.candidate.confirmedFetchHosts,
        targets: preview.candidate.targets.map((target) => ({
          target: target.target,
          targetUrl: target.targetUrl
        }))
      })
    ).rejects.toThrow("Source changed after recipe preview");
    expect(replaceRecipe).not.toHaveBeenCalled();
  });

  it("allows only one assignment or rebuild preview to commit from the same baseline", async () => {
    let current = baseline;
    const replaceRecipe = vi.fn(async () => current.source);
    const service = new SportsSourceService({
      follows: {
        list: async () => [
          {
            id: followId,
            competitionKey: "nfl",
            teamKey: "dal",
            sourceTeamId: "id-dal",
            createdAt: checkedAt
          }
        ]
      },
      sources: {
        getBaseline: async () => current,
        lockOwnerAssignments: async () => undefined,
        countAssignments: async () => 1,
        replaceScopeAssignments: async () => {
          current = { ...current, updatedAt: "2026-08-24T00:00:00.000Z" };
          return current.source;
        },
        replaceRecipe
      } as unknown as SportsSourcesRepository,
      previews: createSportsPreviewStore(),
      discovery: {
        fetch: async (url) => ({
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: "application/rss+xml",
          body: "<rss><channel><title>Publisher</title></channel></rss>",
          truncated: false
        }),
        ai: {
          generateJson: async () => ({ ok: false as const, error: "needs_config" as const }),
          fingerprint: async () => null
        }
      },
      resolveTeams: async () => [
        {
          teamKey: "dal",
          competitionKey: "nfl",
          name: "Dallas Cowboys",
          shortName: "DAL",
          crestUrl: null,
          sourceTeamId: "id-dal"
        }
      ]
    });
    const db = {} as DataContextDb;
    const rebuild = await service.previewRecipeRebuild(db, "owner-1", sourceId);
    const assignments = await service.previewAssignments(db, "owner-1", sourceId, {
      assignments: [{ target: { kind: "follow", followId } }]
    });
    await confirm(service, db, assignments);
    if (!rebuild.confirmationId || !rebuild.candidate || !rebuild.authorizationAcknowledgement) {
      throw new Error("expected successful recipe preview");
    }

    await expect(
      service.confirmRecipeRebuild(db, "owner-1", sourceId, {
        confirmationId: rebuild.confirmationId,
        authorizationAcknowledgement: rebuild.authorizationAcknowledgement,
        canonicalDomain: rebuild.candidate.canonicalDomain,
        confirmedFetchHosts: rebuild.candidate.confirmedFetchHosts,
        targets: rebuild.candidate.targets.map((target) => ({
          target: target.target,
          targetUrl: target.targetUrl
        }))
      })
    ).rejects.toThrow("Source changed after recipe preview");
    expect(replaceRecipe).not.toHaveBeenCalled();
  });

  it("retries through the runtime reader with cache bypass and returns persisted health", async () => {
    const reader = {
      refresh: vi.fn(async () => ({ headlines: [], degraded: false, persistedResults: 1 }))
    };
    const getBaseline = vi.fn(async () => baseline);
    const service = new SportsSourceService({
      follows: { list: async () => [] },
      sources: { getBaseline } as unknown as SportsSourcesRepository,
      previews: createSportsPreviewStore(),
      discovery: {
        fetch: async () => ({ ok: false as const, reason: "network" as const }),
        ai: {
          generateJson: async () => ({ ok: false as const, error: "needs_config" as const }),
          fingerprint: async () => null
        }
      },
      resolveTeams: async () => [],
      dataContext: { withDataContext: async (_context, work) => work({} as DataContextDb) },
      reader
    });
    const accessContext = { actorUserId: "owner-1", requestId: "request-1" };

    await expect(service.retrySource(accessContext, sourceId)).resolves.toBe(baseline.source);
    expect(reader.refresh).toHaveBeenCalledWith(accessContext, { sourceId, bypassCache: true });
    expect(getBaseline).toHaveBeenCalledWith({}, sourceId);
  });
});
