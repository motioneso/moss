import type { AccessContext, DataContextDb } from "@moss/db";
import type { NewsAiPort } from "@moss/news";
import {
  SPORTS_SOURCE_ASSIGNMENT_LIMIT,
  SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
  type ConfirmSportsSourceRecipeRequest,
  type ConfirmSportsSourceRequest,
  type ConfirmSportsSourceAssignmentsRequest,
  type PreviewSportsSourceRequest,
  type PreviewSportsSourceAssignmentsRequest,
  type PreviewSportsSourceAssignmentsResponse,
  type PreviewSportsSourceCandidate,
  type PreviewSportsSourceRecipeResponse,
  type PreviewSportsSourceResponse,
  type SportsBuiltinSourceDto,
  type SportsCustomSourceDto,
  type SportsFollowDto,
  type SportsNewsSourceDto,
  type SportsSourceAssignmentTarget,
  type TeamRef
} from "@moss/shared";

import type { SportsFollowsReader } from "../sports-service.js";
import { catalogEntry } from "./catalog.js";
import {
  resolveSportsSourceInput,
  samePublisherIdentity,
  type SportsDiscoveryBrowserPort,
  type SportsDiscoveryTarget,
  type SportsSafeFetchPort,
  type VerifiedSportsSourceCandidate,
  type VerifiedSportsSourceTarget
} from "./discovery.js";
import type { createSportsPreviewStore } from "./preview-store.js";
import type { SportsPublicSourceReader } from "./public-source-reader.js";
import type { SportsSourceBaseline, SportsSourcesRepository } from "./repository.js";
import type { SportsEspnCoverageRepository } from "./espn-coverage-repository.js";
import {
  hasValidSportsSourceTargets,
  isSportsSportKey,
  SPORTS_SPORT_LABELS,
  sportsSourceTargetKey
} from "./scope.js";

type SportsPreviewStore = ReturnType<typeof createSportsPreviewStore>;

export class SportsSourceRequestError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "SportsSourceRequestError";
  }
}

interface SportsSourceServiceDependencies {
  readonly follows: SportsFollowsReader;
  readonly sources: SportsSourcesRepository;
  readonly espnCoverage?: SportsEspnCoverageRepository;
  readonly previews: SportsPreviewStore;
  readonly discovery: {
    readonly fetch: SportsSafeFetchPort;
    readonly ai: NewsAiPort;
    readonly browser?: SportsDiscoveryBrowserPort;
  };
  readonly resolveTeams: (competitionKey: string) => Promise<readonly TeamRef[]>;
  readonly dataContext?: {
    withDataContext<T>(
      accessContext: AccessContext,
      work: (scopedDb: DataContextDb) => Promise<T>
    ): Promise<T>;
  };
  readonly reader?: Pick<SportsPublicSourceReader, "refresh">;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function targetIdentityMatches(
  expected: readonly {
    readonly target: SportsSourceAssignmentTarget;
    readonly targetUrl: string;
  }[],
  actual: readonly {
    readonly target: SportsSourceAssignmentTarget;
    readonly targetUrl: string;
  }[]
): boolean {
  return (
    expected.length === actual.length &&
    expected.every(
      (target, index) =>
        sportsSourceTargetKey(target.target) ===
          (actual[index] ? sportsSourceTargetKey(actual[index].target) : undefined) &&
        target.targetUrl === actual[index]?.targetUrl
    )
  );
}

function baselineMatches(left: SportsSourceBaseline, right: SportsSourceBaseline): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.validationFingerprint === right.validationFingerprint &&
    left.recipeFingerprint === right.recipeFingerprint &&
    JSON.stringify(left.assignments) === JSON.stringify(right.assignments)
  );
}

function baselineAssignmentTarget(
  assignment: SportsSourceBaseline["assignments"][number]
): SportsSourceAssignmentTarget | null {
  if (assignment.sportKey !== null) {
    return isSportsSportKey(assignment.sportKey)
      ? { kind: "sport", sportKey: assignment.sportKey }
      : null;
  }
  return assignment.followId === null ? null : { kind: "follow", followId: assignment.followId };
}

function candidateResponse(
  candidate: VerifiedSportsSourceCandidate
): NonNullable<PreviewSportsSourceResponse["candidate"]> {
  return {
    label: candidate.label,
    canonicalDomain: candidate.canonicalDomain,
    homepageUrl: candidate.homepageUrl,
    retrievalMethod: candidate.retrievalMethod,
    sampleCount: candidate.sampleCount,
    confirmedFetchHosts: candidate.confirmedFetchHosts,
    sampleHeadlines: candidate.samples.slice(0, 10).map((sample) => sample.headline),
    targets: candidate.targets.map((target) => ({
      target: target.target,
      label: target.label,
      scope: target.scope,
      targetUrl: target.targetUrl,
      sampleHeadlines: target.samples.slice(0, 10).map((sample) => sample.headline)
    }))
  };
}

export class SportsSourceService {
  constructor(private readonly dependencies: SportsSourceServiceDependencies) {}

  async previewNewSource(
    scopedDb: DataContextDb,
    ownerUserId: string,
    input: PreviewSportsSourceRequest
  ): Promise<PreviewSportsSourceResponse> {
    const assignments = input.assignments ?? [];
    if (!hasValidSportsSourceTargets(assignments.map((assignment) => assignment.target))) {
      return { status: "rejected", reason: "invalid_input" };
    }

    const follows = await this.dependencies.follows.list(scopedDb);
    const followById = new Map(follows.map((follow) => [follow.id, follow]));
    const targets: SportsDiscoveryTarget[] = [];
    const teamsByCompetition = new Map<string, readonly TeamRef[]>();
    for (const assignment of assignments) {
      const target = await this.resolveAssignmentTarget(
        assignment.target,
        followById,
        teamsByCompetition
      );
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
      candidate: candidateResponse(result.candidate),
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
      target: target.target,
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
    if (assignmentCount + preview.candidate.targets.length > SPORTS_SOURCE_ASSIGNMENT_LIMIT) {
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

  async previewAssignments(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceId: string,
    input: PreviewSportsSourceAssignmentsRequest
  ): Promise<PreviewSportsSourceAssignmentsResponse> {
    if (!hasValidSportsSourceTargets(input.assignments.map((assignment) => assignment.target))) {
      return { status: "rejected", reason: "invalid_input" };
    }
    const baseline = await this.dependencies.sources.getBaseline(scopedDb, sourceId);
    if (!baseline) throw new SportsSourceRequestError(404, "Source not found");

    const follows = await this.dependencies.follows.list(scopedDb);
    const followById = new Map(follows.map((follow) => [follow.id, follow]));
    const currentByTargetKey = new Map(
      baseline.assignments.flatMap((assignment) => {
        const target = baselineAssignmentTarget(assignment);
        return target ? [[sportsSourceTargetKey(target), assignment] as const] : [];
      })
    );
    const teamsByCompetition = new Map<string, readonly TeamRef[]>();
    const requestedTargets: SportsDiscoveryTarget[] = [];
    const reused = new Map<
      string,
      { id: string; targetUrl: string; parameters: Readonly<Record<string, unknown>> }
    >();

    for (const assignment of input.assignments) {
      const target = await this.resolveAssignmentTarget(
        assignment.target,
        followById,
        teamsByCompetition
      );
      if (!target) return { status: "rejected", reason: "invalid_input" };
      const targetKey = sportsSourceTargetKey(assignment.target);
      const current = currentByTargetKey.get(targetKey);
      let exactTargetUrl: string | undefined;
      if (assignment.exactTargetUrl) {
        try {
          exactTargetUrl = new URL(assignment.exactTargetUrl).toString();
        } catch {
          return { status: "rejected", reason: "invalid_input" };
        }
      }
      if (
        current?.previewStatus === "verified" &&
        current.targetUrl &&
        (!exactTargetUrl || exactTargetUrl === current.targetUrl)
      ) {
        reused.set(targetKey, {
          id: current.id,
          targetUrl: current.targetUrl,
          parameters: current.parameters
        });
      } else {
        requestedTargets.push({ ...target, ...(exactTargetUrl ? { exactTargetUrl } : {}) });
      }
    }

    let discovered: VerifiedSportsSourceCandidate | null = null;
    if (requestedTargets.length > 0) {
      const result = await resolveSportsSourceInput(scopedDb, this.dependencies.discovery, {
        rawUrl: baseline.source.feedUrl ?? baseline.source.homepageUrl,
        targets: requestedTargets,
        persistedAuthority: {
          canonicalDomain: baseline.source.canonicalDomain,
          recipeJson: baseline.recipeJson,
          recipeFingerprint: baseline.recipeFingerprint,
          confirmedFetchHosts: baseline.confirmedFetchHosts
        }
      });
      if (result.status !== "ok") return result;
      if (
        result.candidate.canonicalDomain !== baseline.source.canonicalDomain ||
        result.candidate.recipeFingerprint !== baseline.recipeFingerprint ||
        !sameStrings(result.candidate.confirmedFetchHosts, baseline.confirmedFetchHosts)
      ) {
        return { status: "rejected", reason: "stale_source" };
      }
      discovered = result.candidate;
    }

    const discoveredByTargetKey = new Map(
      (discovered?.targets ?? []).map((target) => [sportsSourceTargetKey(target.target), target])
    );
    const targets: VerifiedSportsSourceTarget[] = [];
    for (const assignment of input.assignments) {
      const targetKey = sportsSourceTargetKey(assignment.target);
      const discoveredTarget = discoveredByTargetKey.get(targetKey);
      if (discoveredTarget) {
        targets.push(discoveredTarget);
        continue;
      }
      const reusedTarget = reused.get(targetKey);
      const target = await this.resolveAssignmentTarget(
        assignment.target,
        followById,
        teamsByCompetition
      );
      if (!reusedTarget || !target) return { status: "rejected", reason: "invalid_input" };
      targets.push({
        ...target,
        targetUrl: reusedTarget.targetUrl,
        parameters: Object.fromEntries(
          Object.entries(reusedTarget.parameters).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        ),
        samples: [],
        checkedAt: baseline.source.lastCheckedAt ?? baseline.source.createdAt
      });
    }

    const samples = discovered?.samples ?? [];
    const candidate: PreviewSportsSourceCandidate = {
      label: baseline.source.label,
      canonicalDomain: baseline.source.canonicalDomain,
      homepageUrl: baseline.source.homepageUrl,
      retrievalMethod: baseline.source.retrievalMethod,
      sampleCount: samples.length,
      confirmedFetchHosts: baseline.confirmedFetchHosts,
      sampleHeadlines: samples.slice(0, 10).map((sample) => sample.headline),
      targets: targets.map((target) => ({
        target: target.target,
        label: target.label,
        scope: target.scope,
        targetUrl: target.targetUrl,
        sampleHeadlines: target.samples.slice(0, 10).map((sample) => sample.headline)
      }))
    };
    const confirmationId = this.dependencies.previews.put({
      kind: "assignment-replacement",
      ownerUserId,
      sourceId,
      baseline,
      candidate,
      reusedAssignmentIds: [...reused.values()].map((assignment) => assignment.id),
      verifiedTargets: discovered?.targets ?? [],
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      createdAt: Date.now()
    });
    return {
      status: "ok",
      confirmationId,
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      candidate
    };
  }

  async confirmAssignments(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceId: string,
    input: ConfirmSportsSourceAssignmentsRequest
  ): Promise<SportsCustomSourceDto> {
    const preview = this.dependencies.previews.take(ownerUserId, input.confirmationId);
    if (!preview || preview.kind !== "assignment-replacement" || preview.sourceId !== sourceId) {
      throw new SportsSourceRequestError(409, "Assignment preview expired or was not found");
    }
    const expectedTargets = preview.candidate.targets.map((target) => ({
      target: target.target,
      targetUrl: target.targetUrl
    }));
    if (
      input.authorizationAcknowledgement !== preview.authorizationAcknowledgement ||
      input.canonicalDomain !== preview.candidate.canonicalDomain ||
      !sameStrings(input.confirmedFetchHosts, preview.candidate.confirmedFetchHosts) ||
      !targetIdentityMatches(input.targets, expectedTargets)
    ) {
      throw new SportsSourceRequestError(409, "Assignment preview identity changed");
    }

    await this.dependencies.sources.lockOwnerAssignments(scopedDb);
    const current = await this.dependencies.sources.getBaseline(scopedDb, sourceId);
    if (!current || !baselineMatches(current, preview.baseline)) {
      throw new SportsSourceRequestError(409, "Source changed after assignment preview");
    }
    const assignmentCount = await this.dependencies.sources.countAssignments(scopedDb);
    if (
      assignmentCount - current.assignments.length + expectedTargets.length >
      SPORTS_SOURCE_ASSIGNMENT_LIMIT
    ) {
      throw new SportsSourceRequestError(400, "A maximum of 20 source assignments is allowed");
    }
    const source = await this.dependencies.sources.replaceScopeAssignments(
      scopedDb,
      sourceId,
      preview.reusedAssignmentIds,
      preview.verifiedTargets
    );
    if (!source) throw new SportsSourceRequestError(404, "Source not found");
    return source;
  }

  async previewRecipeRebuild(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceId: string
  ): Promise<PreviewSportsSourceRecipeResponse> {
    const baseline = await this.dependencies.sources.getBaseline(scopedDb, sourceId);
    if (!baseline) throw new SportsSourceRequestError(404, "Source not found");

    const follows = await this.dependencies.follows.list(scopedDb);
    const followById = new Map(follows.map((follow) => [follow.id, follow]));
    const teamsByCompetition = new Map<string, readonly TeamRef[]>();
    const targets: SportsDiscoveryTarget[] = [];
    for (const assignment of baseline.assignments) {
      const assignmentTarget = baselineAssignmentTarget(assignment);
      if (!assignmentTarget) return { status: "rejected", reason: "stale_source" };
      const target = await this.resolveAssignmentTarget(
        assignmentTarget,
        followById,
        teamsByCompetition
      );
      if (!target) return { status: "rejected", reason: "stale_source" };
      targets.push(target);
    }

    const result = await resolveSportsSourceInput(scopedDb, this.dependencies.discovery, {
      rawUrl: baseline.source.feedUrl ?? baseline.source.homepageUrl,
      targets
    });
    if (result.status !== "ok") return result;
    if (!samePublisherIdentity(result.candidate.canonicalDomain, baseline.source.canonicalDomain)) {
      return { status: "rejected", reason: "stale_source" };
    }
    // A rebuild refreshes retrieval, not identity: the same-publisher check above already
    // established the candidate is the row's own publisher, so keep the row's canonical_domain
    // rather than the rediscovered host (e.g. www.), which can collide with another saved source
    // that already owns that exact domain (sports_custom_sources_owner_user_id_canonical_domain_key).
    const candidate: VerifiedSportsSourceCandidate = {
      ...result.candidate,
      canonicalDomain: baseline.source.canonicalDomain
    };

    const confirmationId = this.dependencies.previews.put({
      kind: "recipe-rebuild",
      ownerUserId,
      sourceId,
      baseline,
      candidate,
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      createdAt: Date.now()
    });
    return {
      status: "ok",
      confirmationId,
      authorizationAcknowledgement: SPORTS_SOURCE_AUTHORIZATION_ACKNOWLEDGEMENT,
      candidate: candidateResponse(candidate)
    };
  }

  async confirmRecipeRebuild(
    scopedDb: DataContextDb,
    ownerUserId: string,
    sourceId: string,
    input: ConfirmSportsSourceRecipeRequest
  ): Promise<SportsCustomSourceDto> {
    const preview = this.dependencies.previews.take(ownerUserId, input.confirmationId);
    if (!preview || preview.kind !== "recipe-rebuild" || preview.sourceId !== sourceId) {
      throw new SportsSourceRequestError(409, "Recipe preview expired or was not found");
    }
    const expectedTargets = preview.candidate.targets.map((target) => ({
      target: target.target,
      targetUrl: target.targetUrl
    }));
    if (
      input.authorizationAcknowledgement !== preview.authorizationAcknowledgement ||
      input.canonicalDomain !== preview.candidate.canonicalDomain ||
      !sameStrings(input.confirmedFetchHosts, preview.candidate.confirmedFetchHosts) ||
      !targetIdentityMatches(input.targets, expectedTargets)
    ) {
      throw new SportsSourceRequestError(409, "Recipe preview identity changed");
    }

    await this.dependencies.sources.lockOwnerAssignments(scopedDb);
    const current = await this.dependencies.sources.getBaseline(scopedDb, sourceId);
    if (!current || !baselineMatches(current, preview.baseline)) {
      throw new SportsSourceRequestError(409, "Source changed after recipe preview");
    }
    const source = await this.dependencies.sources.replaceRecipe(
      scopedDb,
      sourceId,
      preview.candidate
    );
    if (!source) throw new SportsSourceRequestError(404, "Source not found");
    return source;
  }

  async retrySource(
    accessContext: AccessContext,
    sourceId: string
  ): Promise<SportsCustomSourceDto> {
    const { dataContext, reader } = this.dependencies;
    if (!dataContext || !reader) throw new Error("Sports source Retry is not configured");
    await reader.refresh(accessContext, { sourceId, bypassCache: true });
    const baseline = await dataContext.withDataContext(accessContext, (db) =>
      this.dependencies.sources.getBaseline(db, sourceId)
    );
    if (!baseline) throw new SportsSourceRequestError(404, "Source not found");
    return baseline.source;
  }

  async listSources(scopedDb: DataContextDb): Promise<readonly SportsNewsSourceDto[]> {
    if (!this.dependencies.espnCoverage) {
      throw new Error("ESPN sports source coverage is not configured");
    }
    const [coverage, customSources] = await Promise.all([
      this.dependencies.espnCoverage.get(scopedDb),
      this.dependencies.sources.list(scopedDb)
    ]);
    return [
      { kind: "builtin", id: "espn", label: "ESPN", ...coverage },
      ...customSources.map((source) => ({ kind: "custom" as const, ...source }))
    ];
  }

  async replaceEspnCoverage(
    scopedDb: DataContextDb,
    targets: readonly SportsSourceAssignmentTarget[]
  ): Promise<SportsBuiltinSourceDto> {
    if (!this.dependencies.espnCoverage) {
      throw new Error("ESPN sports source coverage is not configured");
    }
    if (!hasValidSportsSourceTargets(targets)) {
      throw new SportsSourceRequestError(400, "Invalid ESPN sports coverage targets");
    }
    const visibleFollowIds = new Set(
      (await this.dependencies.follows.list(scopedDb)).map((follow) => follow.id)
    );
    if (
      targets.some((target) => target.kind === "follow" && !visibleFollowIds.has(target.followId))
    ) {
      throw new SportsSourceRequestError(400, "ESPN coverage contains an unavailable follow");
    }
    const coverage = await this.dependencies.espnCoverage.replace(scopedDb, targets);
    return { kind: "builtin", id: "espn", label: "ESPN", ...coverage };
  }

  removeSource(scopedDb: DataContextDb, sourceId: string): Promise<boolean> {
    return this.dependencies.sources.remove(scopedDb, sourceId);
  }

  private async resolveTarget(
    follow: SportsFollowDto,
    teamsByCompetition: Map<string, readonly TeamRef[]>
  ): Promise<SportsDiscoveryTarget | null> {
    const competition = catalogEntry(follow.competitionKey);
    if (!competition) return null;
    if (follow.teamKey === null) {
      return {
        target: { kind: "follow", followId: follow.id },
        label: competition.label,
        scope: "competition"
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
      target: { kind: "follow", followId: follow.id },
      label: team.name,
      scope: "team"
    };
  }

  private resolveAssignmentTarget(
    target: SportsSourceAssignmentTarget,
    followById: ReadonlyMap<string, SportsFollowDto>,
    teamsByCompetition: Map<string, readonly TeamRef[]>
  ): Promise<SportsDiscoveryTarget | null> {
    if (target.kind === "sport") {
      return Promise.resolve({
        target,
        label: SPORTS_SPORT_LABELS[target.sportKey],
        scope: "sport"
      });
    }
    const follow = followById.get(target.followId);
    return follow ? this.resolveTarget(follow, teamsByCompetition) : Promise.resolve(null);
  }
}
