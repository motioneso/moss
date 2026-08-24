// tests/unit/sports-chat-tools.test.ts
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import type {
  CreateSportsFollowRequest,
  SportsCustomSourceDto,
  SportsFollowDto
} from "@moss/shared";
import type { ToolExecute } from "@moss/module-sdk";

import {
  configureSportsChatTools,
  sportsConfirmSourceAssignmentsExecute,
  sportsConfirmSourceExecute,
  sportsConfirmSourceRecipeExecute,
  sportsFollowTeamExecute,
  sportsListSourcesExecute,
  sportsPreviewSourceAssignmentsExecute,
  sportsPreviewSourceExecute,
  sportsRebuildSourceRecipeExecute,
  sportsRemoveSourceExecute,
  sportsRetrySourceExecute,
  summarizeSportsConfirmSource,
  summarizeSportsConfirmSourceAssignments,
  summarizeSportsConfirmSourceRecipe,
  sportsUnfollowTeamExecute
} from "../../packages/sports/src/chat-tools.js";
import type { SportsFollowsWriter } from "../../packages/sports/src/sports-service.js";

const FAKE_DB = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const CTX = { actorUserId: "user-a", requestId: "req-1", chatSessionId: "chat-1" };

function makeFakeWriter(): SportsFollowsWriter {
  const rows: SportsFollowDto[] = [];
  return {
    async list() {
      return rows;
    },
    async create(_db: DataContextDb, input: CreateSportsFollowRequest) {
      const teamKey = input.teamKey ?? null;
      const existing = rows.find(
        (r) => r.competitionKey === input.competitionKey && r.teamKey === teamKey
      );
      if (existing) return existing;
      const created: SportsFollowDto = {
        id: `f-${rows.length + 1}`,
        competitionKey: input.competitionKey,
        teamKey,
        createdAt: "2026-07-27T00:00:00.000Z"
      };
      rows.push(created);
      return created;
    },
    async remove(_db: DataContextDb, id: string) {
      const index = rows.findIndex((r) => r.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    }
  };
}

/** Roster stand-in for the league-teams lookup `followTeam` performs to close an
 *  assistant-supplied teamKey against the catalog (#1265 QA BLOCKING-1a). */
function makeFakeDatasetClient(rosters: Record<string, readonly string[]> = { nfl: ["dal"] }) {
  return {
    async getDataset(_key: string, params: Record<string, unknown>) {
      const competitionKey = String(params.competitionKey ?? "");
      return {
        data: (rosters[competitionKey] ?? []).map((teamKey) => ({
          teamKey,
          competitionKey,
          name: teamKey.toUpperCase(),
          shortName: teamKey.toUpperCase(),
          crestUrl: null,
          sourceTeamId: null
        })),
        degraded: false,
        cacheMiss: false
      };
    }
  } as never;
}

async function callTool(execute: ToolExecute, input: Record<string, unknown>) {
  return execute(FAKE_DB, input, CTX);
}

describe("sports chat tools (#1265)", () => {
  it("shows the exact host and target authority in source confirmation summaries", () => {
    const input = {
      sourceId: "source-1",
      canonicalDomain: "publisher.example",
      confirmedFetchHosts: ["publisher.example", "api.publisher.example"],
      targets: [{ followId: "follow-1", targetUrl: "https://api.publisher.example/team/1" }]
    };
    for (const summarize of [
      summarizeSportsConfirmSource,
      summarizeSportsConfirmSourceAssignments,
      summarizeSportsConfirmSourceRecipe
    ]) {
      const summary = summarize(input, CTX);
      expect(summary).toContain("publisher.example, api.publisher.example");
      expect(summary).toContain("follow-1 -> https://api.publisher.example/team/1");
    }
  });
  it("rejects a competitionKey outside the catalog before any write", async () => {
    configureSportsChatTools(makeFakeDatasetClient(), makeFakeWriter());
    const result = await callTool(sportsFollowTeamExecute, { competitionKey: "not-a-league" });
    expect((result.data as { error?: string }).error).toMatch(/unknown competition/i);
  });

  it("follow then unfollow via the tools is idempotent", async () => {
    const writer = makeFakeWriter();
    configureSportsChatTools(makeFakeDatasetClient(), writer);

    const followed = await callTool(sportsFollowTeamExecute, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect((followed.data as { follow?: SportsFollowDto }).follow?.teamKey).toBe("dal");

    const unfollowed = await callTool(sportsUnfollowTeamExecute, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect((unfollowed.data as { removed?: boolean }).removed).toBe(true);

    const reunfollowed = await callTool(sportsUnfollowTeamExecute, {
      competitionKey: "nfl",
      teamKey: "dal"
    });
    expect((reunfollowed.data as { removed?: boolean }).removed).toBe(false);
  });

  // #1265 QA BLOCKING-1(a) at the tool surface: this tool auto-runs under a
  // `granted_at_install` grant, so a model-supplied teamKey never faces a confirmation card.
  // An off-roster key must come back as a tool error, not a persisted follow.
  it("rejects an off-roster teamKey before any write", async () => {
    const writer = makeFakeWriter();
    configureSportsChatTools(makeFakeDatasetClient(), writer);
    const result = await callTool(sportsFollowTeamExecute, {
      competitionKey: "nfl",
      teamKey: "../../../evil"
    });
    expect((result.data as { error?: string }).error).toMatch(/unknown team/i);
    expect((result.data as { follow?: SportsFollowDto }).follow).toBeUndefined();
    expect(await writer.list(FAKE_DB)).toHaveLength(0);
  });

  it("rejects a missing competitionKey before any write", async () => {
    configureSportsChatTools(makeFakeDatasetClient(), makeFakeWriter());
    const result = await callTool(sportsFollowTeamExecute, {});
    expect((result.data as { error?: string }).error).toMatch(/provide a competitionkey/i);
  });

  it("uses one actor-scoped source service for status and every recovery action", async () => {
    const source: SportsCustomSourceDto = {
      id: "11111111-1111-1111-1111-111111111111",
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
      createdAt: "2026-08-24T12:00:00.000Z"
    };
    const preview = {
      status: "ok" as const,
      confirmationId: "confirmation-1",
      authorizationAcknowledgement: "authorized",
      candidate: {
        label: source.label,
        canonicalDomain: source.canonicalDomain,
        homepageUrl: source.homepageUrl,
        retrievalMethod: source.retrievalMethod,
        sampleCount: 1,
        confirmedFetchHosts: [source.canonicalDomain],
        sampleHeadlines: ["Public headline"],
        targets: []
      }
    };
    const sources = {
      listSources: vi.fn(async () => [source]),
      previewNewSource: vi.fn(async () => preview),
      confirmNewSource: vi.fn(async () => source),
      previewAssignments: vi.fn(async () => preview),
      confirmAssignments: vi.fn(async () => source),
      previewRecipeRebuild: vi.fn(async () => preview),
      confirmRecipeRebuild: vi.fn(async () => source),
      retrySource: vi.fn(async () => source),
      removeSource: vi.fn(async () => true)
    };
    configureSportsChatTools(makeFakeDatasetClient(), makeFakeWriter(), sources as never);
    const confirmation = {
      sourceId: source.id,
      confirmationId: preview.confirmationId,
      authorizationAcknowledgement: preview.authorizationAcknowledgement,
      canonicalDomain: source.canonicalDomain,
      confirmedFetchHosts: [source.canonicalDomain],
      targets: []
    };

    await expect(callTool(sportsListSourcesExecute, {})).resolves.toEqual({
      data: { sources: [source] }
    });
    const previewed = await callTool(sportsPreviewSourceExecute, { url: source.homepageUrl });
    expect(previewed.data).not.toHaveProperty("recipe");
    await callTool(sportsConfirmSourceExecute, confirmation);
    await callTool(sportsPreviewSourceAssignmentsExecute, {
      sourceId: source.id,
      assignments: []
    });
    await callTool(sportsConfirmSourceAssignmentsExecute, confirmation);
    await callTool(sportsRebuildSourceRecipeExecute, { sourceId: source.id });
    await callTool(sportsConfirmSourceRecipeExecute, confirmation);
    await callTool(sportsRetrySourceExecute, { sourceId: source.id });
    await expect(callTool(sportsRemoveSourceExecute, { sourceId: source.id })).resolves.toEqual({
      data: { removed: true }
    });

    expect(sources.previewNewSource).toHaveBeenCalledWith(
      FAKE_DB,
      CTX.actorUserId,
      expect.objectContaining({ url: source.homepageUrl })
    );
    expect(sources.retrySource).toHaveBeenCalledWith(
      { actorUserId: CTX.actorUserId, requestId: CTX.requestId },
      source.id
    );
    expect(sources.removeSource).toHaveBeenCalledWith(FAKE_DB, source.id);
  });

  it("keeps an unknown or cross-owner source indistinguishable from not found", async () => {
    const removeSource = vi.fn(async () => true);
    configureSportsChatTools(makeFakeDatasetClient(), makeFakeWriter(), {
      listSources: async () => [],
      removeSource
    } as never);

    const result = await callTool(sportsRemoveSourceExecute, {
      sourceId: "11111111-1111-1111-1111-111111111111"
    });
    expect(result.data.error).toBe("That sports source was not found.");
    expect(removeSource).not.toHaveBeenCalled();
  });
});
