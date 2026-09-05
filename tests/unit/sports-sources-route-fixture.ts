import type { DataContextDb } from "@moss/db";
import type { SportsCustomSourceDto } from "@moss/shared";

import type { VerifiedSportsSourceCandidate } from "../../packages/sports/src/source/discovery.js";

export interface FakeSourcesRepo {
  list(scopedDb: DataContextDb): Promise<SportsCustomSourceDto[]>;
  create(
    scopedDb: DataContextDb,
    input: { candidate: VerifiedSportsSourceCandidate }
  ): Promise<SportsCustomSourceDto | { limitExceeded: true }>;
  lockOwnerAssignments(scopedDb: DataContextDb): Promise<void>;
  countAssignments(scopedDb: DataContextDb): Promise<number>;
  remove(scopedDb: DataContextDb, id: string): Promise<boolean>;
  setAssignments(
    scopedDb: DataContextDb,
    sourceId: string,
    followIds: readonly string[]
  ): Promise<SportsCustomSourceDto | null>;
  removed: string[];
  assignments: { sourceId: string; followIds: readonly string[] }[];
  lockCount: number;
}

export function makeSourcesRepo(
  initial: SportsCustomSourceDto[],
  atLimit = false
): FakeSourcesRepo {
  const sources = [...initial];
  const removed: string[] = [];
  const assignments: { sourceId: string; followIds: readonly string[] }[] = [];
  return {
    removed,
    assignments,
    lockCount: 0,
    lockOwnerAssignments: async function () {
      this.lockCount++;
    },
    countAssignments: async () =>
      sources.reduce((count, source) => count + source.assignedFollowIds.length, 0),
    list: async () => sources,
    create: async (_db, input) => {
      if (atLimit) return { limitExceeded: true };
      const created: SportsCustomSourceDto = {
        id: "22222222-2222-2222-2222-222222222222",
        label: input.candidate.label,
        canonicalDomain: input.candidate.canonicalDomain,
        homepageUrl: input.candidate.homepageUrl,
        feedUrl: input.candidate.feedUrl,
        retrievalMethod: input.candidate.retrievalMethod,
        enabled: true,
        healthState: "healthy",
        healthReasonCode: null,
        healthMessage: null,
        lastCheckedAt: input.candidate.checkedAt,
        lastSuccessAt: input.candidate.checkedAt,
        recipeStatus: input.candidate.retrievalMethod === "feed" ? "feed" : "ready",
        photoStatus: "pending",
        photosFoundByMoss: false,
        assignedFollowIds: input.candidate.targets.flatMap((target) =>
          target.target.kind === "follow" ? [target.target.followId] : []
        ),
        assignments: input.candidate.targets.map((target, index) => ({
          id: `33333333-3333-3333-3333-33333333333${index}`,
          followId: target.target.kind === "follow" ? target.target.followId : null,
          sportKey: target.target.kind === "sport" ? target.target.sportKey : null,
          targetUrl: target.targetUrl,
          previewStatus: "verified",
          healthState: "healthy",
          healthReasonCode: null,
          healthMessage: null,
          lastCheckedAt: target.checkedAt,
          lastSuccessAt: target.checkedAt,
          createdAt: target.checkedAt
        })),
        createdAt: "2026-08-21T00:00:00.000Z"
      };
      sources.push(created);
      return created;
    },
    remove: async (_db, id) => {
      removed.push(id);
      return sources.some((source) => source.id === id);
    },
    setAssignments: async (_db, sourceId, followIds) => {
      assignments.push({ sourceId, followIds });
      const source = sources.find((item) => item.id === sourceId);
      if (!source) return null;
      return { ...source, assignedFollowIds: [...followIds] };
    }
  };
}
