import type { DataContextDb } from "@moss/db";
import type { NewsAiPort } from "@moss/news";
import {
  SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
  type ConfirmSportsSourceRequest,
  type PreviewSportsSourceRequest,
  type PreviewSportsSourceResponse,
  type SportsCustomSourceDto,
  type SportsFollowDto,
  type TeamRef
} from "@moss/shared";

import type { SportsFollowsReader } from "../sports-service.js";
import { catalogEntry } from "./catalog.js";
import {
  resolveSportsSourceInput,
  type SportsDiscoveryBrowserPort,
  type SportsDiscoveryTarget,
  type SportsSafeFetchPort
} from "./discovery.js";
import type { createSportsPreviewStore } from "./preview-store.js";
import type { SportsSourcesRepository } from "./repository.js";

type SportsPreviewStore = ReturnType<typeof createSportsPreviewStore>;

export class SportsSourceRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 409,
    message: string
  ) {
    super(message);
    this.name = "SportsSourceRequestError";
  }
}

interface SportsSourceServiceDependencies {
  readonly follows: SportsFollowsReader;
  readonly sources: SportsSourcesRepository;
  readonly previews: SportsPreviewStore;
  readonly discovery: {
    readonly fetch: SportsSafeFetchPort;
    readonly ai: NewsAiPort;
    readonly browser?: SportsDiscoveryBrowserPort;
  };
  readonly resolveTeams: (competitionKey: string) => Promise<readonly TeamRef[]>;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function targetIdentityMatches(
  expected: readonly { readonly followId: string; readonly targetUrl: string }[],
  actual: readonly { readonly followId: string; readonly targetUrl: string }[]
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (target, index) =>
        target.followId === actual[index]?.followId && target.targetUrl === actual[index]?.targetUrl
    )
  );
}

export class SportsSourceService {
  constructor(private readonly dependencies: SportsSourceServiceDependencies) {}

  async previewNewSource(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: PreviewSportsSourceRequest
  ): Promise<PreviewSportsSourceResponse> {
    const assignments = input.assignments ?? [];
    const selectedIds = new Set(assignments.map((assignment) => assignment.followId));
    if (selectedIds.size !== assignments.length) {
      return { status: "rejected", reason: "invalid_input" };
    }

    const follows = await this.dependencies.follows.list(scopedDb);
    const followById = new Map(follows.map((follow) => [follow.id, follow]));
    const targets: SportsDiscoveryTarget[] = [];
    const teamsByCompetition = new Map<string, readonly TeamRef[]>();
    for (const assignment of assignments) {
      const follow = followById.get(assignment.followId);
      if (!follow) return { status: "rejected", reason: "invalid_input" };
      const target = await this.resolveTarget(follow, teamsByCompetition);
      if (!target) return { status: "rejected", reason: "invalid_input" };
      targets.push({
        ...target,
        ...(assignment.exactTargetUrl ? { exactTargetUrl: assignment.exactTargetUrl } : {})
      });
    }

    const result = await resolveSportsSourceInput(scopedDb, this.dependencies.discovery, {
      rawUrl: input.url,
      targets
    });
    if (result.status !== "ok") return result;

    const existing = await this.dependencies.sources.list(scopedDb);
    const duplicate =
      existing.find((source) => source.canonicalDomain === result.candidate.canonicalDomain) ??
      null;
    const confirmationId = this.dependencies.previews.put({
      kind: "new-source",
      ownerUserId,
      submittedUrl: input.url,
      candidate: result.candidate,
      duplicateOfSourceId: duplicate?.id ?? null,
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      createdAt: Date.now()
    });

    return {
      status: "ok",
      confirmationId,
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      candidate: {
        label: result.candidate.label,
        canonicalDomain: result.candidate.canonicalDomain,
        homepageUrl: result.candidate.homepageUrl,
        retrievalMethod: result.candidate.retrievalMethod,
        sampleCount: result.candidate.sampleCount,
        confirmedFetchHosts: result.candidate.confirmedFetchHosts,
        sampleHeadlines: result.candidate.samples.slice(0, 10).map((sample) => sample.headline),
        targets: result.candidate.targets.map((target) => ({
          followId: target.followId,
          competitionKey: target.competitionKey,
          competitionLabel: target.competitionLabel,
          teamKey: target.teamKey,
          teamLabel: target.teamLabel,
          scope: target.scope,
          targetUrl: target.targetUrl,
          sampleHeadlines: target.samples.slice(0, 10).map((sample) => sample.headline)
        }))
      },
      ...(duplicate ? { duplicateOfSourceId: duplicate.id } : {})
    };
  }

  async confirmNewSource(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: ConfirmSportsSourceRequest
  ): Promise<SportsCustomSourceDto> {
    const preview = this.dependencies.previews.take(ownerUserId, input.confirmationId);
    if (!preview || preview.kind !== "new-source") {
      throw new SportsSourceRequestError(409, "Source preview expired or was not found");
    }
    const expectedTargets = preview.candidate.targets.map((target) => ({
      followId: target.followId,
      targetUrl: target.targetUrl
    }));
    if (
      input.authorizationAcknowledgement !== preview.authorizationAcknowledgement ||
      input.canonicalDomain !== preview.candidate.canonicalDomain ||
      !sameStrings(input.confirmedFetchHosts, preview.candidate.confirmedFetchHosts) ||
      !targetIdentityMatches(input.targets, expectedTargets)
    ) {
      throw new SportsSourceRequestError(409, "Source preview identity changed");
    }

    await this.dependencies.sources.lockOwnerAssignments(scopedDb);
    const existing = await this.dependencies.sources.list(scopedDb);
    if (existing.some((source) => source.canonicalDomain === preview.candidate.canonicalDomain)) {
      throw new SportsSourceRequestError(409, "Source already exists");
    }
    const assignmentCount = await this.dependencies.sources.countAssignments(scopedDb);
    if (assignmentCount + preview.candidate.targets.length > 20) {
      throw new SportsSourceRequestError(400, "A maximum of 20 source assignments is allowed");
    }
    const created = await this.dependencies.sources.create(scopedDb, {
      candidate: preview.candidate
    });
    if ("limitExceeded" in created) {
      throw new SportsSourceRequestError(400, "A maximum of 10 custom sources is allowed");
    }
    return created;
  }

  private async resolveTarget(
    follow: SportsFollowDto,
    teamsByCompetition: Map<string, readonly TeamRef[]>
  ): Promise<SportsDiscoveryTarget | null> {
    const competition = catalogEntry(follow.competitionKey);
    if (!competition) return null;
    if (follow.teamKey === null) {
      return {
        followId: follow.id,
        competitionKey: follow.competitionKey,
        competitionLabel: competition.label,
        teamKey: null,
        teamLabel: null
      };
    }
    let teams = teamsByCompetition.get(follow.competitionKey);
    if (!teams) {
      teams = await this.dependencies.resolveTeams(follow.competitionKey);
      teamsByCompetition.set(follow.competitionKey, teams);
    }
    const team = teams.find((candidate) => candidate.teamKey === follow.teamKey);
    if (!team) return null;
    return {
      followId: follow.id,
      competitionKey: follow.competitionKey,
      competitionLabel: competition.label,
      teamKey: follow.teamKey,
      teamLabel: team.name
    };
  }
}
