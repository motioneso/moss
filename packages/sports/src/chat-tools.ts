import type { DatasetClient } from "@moss/datasets";
import { assertDataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult, ToolSummarize } from "@moss/module-sdk";
import type {
  ConfirmSportsSourceAssignmentsRequest,
  ConfirmSportsSourceRecipeRequest,
  ConfirmSportsSourceRequest,
  PreviewSportsSourceAssignmentsRequest,
  PreviewSportsSourceRequest
} from "@moss/shared";

import { SportsFollowsRepository } from "./repository.js";
import { SportsService, type SportsFollowsWriter } from "./sports-service.js";
import { SportsSourceRequestError, type SportsSourceService } from "./source/service.js";

/**
 * Content-write counterpart to `briefing-tool.ts`'s read-only singleton — same composition-root
 * timing constraint (constructed once at boot, before any request reaches `execute`), kept in its
 * own file because these are write tools with their own action family (Spec 2), not the briefing
 * read path. `writer` is injectable so tests don't need a real Postgres-backed repository.
 */
let service: SportsService | undefined;
let sourceService: SportsSourceService | undefined;

export function configureSportsChatTools(
  datasetClient: DatasetClient,
  writer: SportsFollowsWriter = new SportsFollowsRepository(),
  sources?: SportsSourceService
): void {
  service = new SportsService({
    datasetClient,
    dataContext: {
      withDataContext() {
        throw new Error("sports chat tools read/write the gateway-scoped db directly");
      }
    },
    repository: writer
  });
  sourceService = sources;
}

/**
 * Test-only: restores the module-wide singleton to its unconfigured state (same convention as
 * @moss/web-research's setWebFetchForTests et al). A test that calls configureSportsChatTools
 * must call this in an afterEach, or the fake writer/dataset client it installed leaks into
 * whatever test runs next in the same worker.
 */
export function resetSportsChatToolsForTests(): void {
  service = undefined;
  sourceService = undefined;
}

function stringField(input: unknown, key: string): string | undefined {
  const value = (input as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function sourceAuthoritySummary(input: unknown): string {
  const value = input as Partial<ConfirmSportsSourceRequest> | undefined;
  const publisher = stringField(input, "canonicalDomain") ?? "unknown publisher";
  const hosts = Array.isArray(value?.confirmedFetchHosts)
    ? value.confirmedFetchHosts.join(", ")
    : "";
  const targets = Array.isArray(value?.targets)
    ? value.targets.map((target) => `${target.followId} -> ${target.targetUrl}`).join(", ")
    : "";
  return `; publisher: ${publisher}; hosts: ${hosts || "none"}; targets: ${targets || "none"}`;
}

function requireService(): SportsService {
  if (!service) {
    throw new Error(
      "sports chat tools used before configureSportsChatTools ran (composition-root bug)"
    );
  }
  return service;
}

function requireSourceService(): SportsSourceService {
  if (!sourceService) {
    throw new Error(
      "sports source chat tools used before configureSportsChatTools ran (composition-root bug)"
    );
  }
  return sourceService;
}

async function sourceTool(work: () => Promise<Record<string, unknown>>): Promise<ToolResult> {
  try {
    return { data: await work() };
  } catch (error) {
    if (error instanceof SportsSourceRequestError) return { data: { error: error.message } };
    throw error;
  }
}

export const sportsFollowTeamExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const competitionKey = stringField(input, "competitionKey");
  if (!competitionKey) return { data: { error: "Provide a competitionKey to follow." } };
  const teamKey = stringField(input, "teamKey") ?? null;
  const result = await requireService().followTeam(scopedDb, { competitionKey, teamKey });
  if (!result.ok) return { data: { error: result.error } };
  return { data: { follow: result.follow } };
};

export const summarizeSportsFollowTeam: ToolSummarize = (input) => {
  const competitionKey = stringField(input, "competitionKey") ?? "unknown competition";
  const teamKey = stringField(input, "teamKey");
  return teamKey ? `Follow ${teamKey} (${competitionKey})` : `Follow all of ${competitionKey}`;
};

export const sportsUnfollowTeamExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const competitionKey = stringField(input, "competitionKey");
  if (!competitionKey) return { data: { error: "Provide a competitionKey to unfollow." } };
  const teamKey = stringField(input, "teamKey") ?? null;
  const result = await requireService().unfollowTeam(scopedDb, { competitionKey, teamKey });
  if (!result.ok) return { data: { error: result.error } };
  return { data: { removed: result.removed } };
};

export const summarizeSportsUnfollowTeam: ToolSummarize = (input) => {
  const competitionKey = stringField(input, "competitionKey") ?? "unknown competition";
  const teamKey = stringField(input, "teamKey");
  return teamKey ? `Unfollow ${teamKey} (${competitionKey})` : `Unfollow all of ${competitionKey}`;
};

export const sportsListSourcesExecute: ToolExecute = async (scopedDb): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  return { data: { sources: await requireSourceService().listSources(scopedDb) } };
};

export const sportsPreviewSourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  return sourceTool(async () => ({
    ...(await requireSourceService().previewNewSource(
      scopedDb,
      ctx.actorUserId,
      input as unknown as PreviewSportsSourceRequest
    ))
  }));
};

export const sportsConfirmSourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  return sourceTool(async () => ({
    source: await requireSourceService().confirmNewSource(
      scopedDb,
      ctx.actorUserId,
      input as unknown as ConfirmSportsSourceRequest
    )
  }));
};

export const sportsPreviewSourceAssignmentsExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to update." } };
  return sourceTool(async () => ({
    ...(await requireSourceService().previewAssignments(
      scopedDb,
      ctx.actorUserId,
      sourceId,
      input as unknown as PreviewSportsSourceAssignmentsRequest
    ))
  }));
};

export const sportsConfirmSourceAssignmentsExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to update." } };
  return sourceTool(async () => ({
    source: await requireSourceService().confirmAssignments(
      scopedDb,
      ctx.actorUserId,
      sourceId,
      input as unknown as ConfirmSportsSourceAssignmentsRequest
    )
  }));
};

export const sportsRebuildSourceRecipeExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to rebuild." } };
  return sourceTool(async () => ({
    ...(await requireSourceService().previewRecipeRebuild(scopedDb, ctx.actorUserId, sourceId))
  }));
};

export const sportsConfirmSourceRecipeExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to rebuild." } };
  return sourceTool(async () => ({
    source: await requireSourceService().confirmRecipeRebuild(
      scopedDb,
      ctx.actorUserId,
      sourceId,
      input as unknown as ConfirmSportsSourceRecipeRequest
    )
  }));
};

export const sportsRetrySourceExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to retry." } };
  return sourceTool(async () => ({
    source: await requireSourceService().retrySource(
      { actorUserId: ctx.actorUserId, requestId: ctx.requestId },
      sourceId
    )
  }));
};

export const sportsRemoveSourceExecute: ToolExecute = async (
  scopedDb,
  input
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const sourceId = stringField(input, "sourceId");
  if (!sourceId) return { data: { error: "Provide the sourceId to remove." } };
  const source = (await requireSourceService().listSources(scopedDb)).find(
    (item) => item.id === sourceId
  );
  if (!source) return { data: { error: "That sports source was not found." } };
  return { data: { removed: await requireSourceService().removeSource(scopedDb, sourceId) } };
};

export const summarizeSportsConfirmSource: ToolSummarize = (input) =>
  `Add sports source${sourceAuthoritySummary(input)}`;

export const summarizeSportsConfirmSourceAssignments: ToolSummarize = (input) =>
  `Replace assignments for sports source ${stringField(input, "sourceId") ?? "unknown id"}${sourceAuthoritySummary(input)}`;

export const summarizeSportsConfirmSourceRecipe: ToolSummarize = (input) =>
  `Replace the recipe for sports source ${stringField(input, "sourceId") ?? "unknown id"}${sourceAuthoritySummary(input)}`;

export const summarizeSportsRetrySource: ToolSummarize = (input) =>
  `Retry sports source ${stringField(input, "sourceId") ?? "unknown id"}`;

export const summarizeSportsRemoveSource: ToolSummarize = (input) =>
  `Remove sports source ${stringField(input, "sourceId") ?? "unknown id"}`;
