import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import { SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT } from "@moss/shared";

import { createSportsPreviewStore } from "../../packages/sports/src/source/preview-store.js";
import type {
  SportsSourceBaseline,
  SportsSourcesRepository
} from "../../packages/sports/src/source/repository.js";
import { SportsSourceService } from "../../packages/sports/src/source/service.js";

const followId = "11111111-1111-1111-1111-111111111111";
const sourceId = "22222222-2222-2222-2222-222222222222";
const assignmentId = "33333333-3333-3333-3333-333333333333";
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
    assignedFollowIds: [followId],
    assignments: [
      {
        id: assignmentId,
        followId,
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
      targetUrl: "https://publisher.example.com/feed.xml",
      parameters: {},
      previewStatus: "verified"
    }
  ]
};

function setup() {
  const replaceAssignments = vi.fn(async () => baseline.source);
  const fetch = vi.fn(async () => ({ ok: false as const, reason: "network" as const }));
  const sources = {
    getBaseline: vi.fn(async () => baseline),
    lockOwnerAssignments: vi.fn(async () => undefined),
    countAssignments: vi.fn(async () => 1),
    replaceAssignments
  } as unknown as SportsSourcesRepository;
  const service = new SportsSourceService({
    follows: {
      list: async () => [
        { id: followId, competitionKey: "nfl", teamKey: "dal", createdAt: checkedAt }
      ]
    },
    sources,
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
        crestUrl: null
      }
    ]
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
      followId: target.followId,
      targetUrl: target.targetUrl
    }))
  });
}

describe("SportsSourceService assignment replacement", () => {
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
      assignments: [{ followId }]
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
});
