// tests/unit/sports-chat-tools.test.ts
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";

import { dataContextBrand, type DataContextDb } from "@moss/db";
import { VaultContextRunner } from "@moss/vault";
import type { SportsCustomSourceDto, SportsFollowDto } from "@moss/shared";
import type { CreateSportsFollowInput } from "../../packages/sports/src/repository.js";
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
import { SportsPhotoStore } from "../../packages/sports/src/source/photo-store.js";
import { SportsSourceService } from "../../packages/sports/src/source/service.js";
import type { SportsFollowsWriter } from "../../packages/sports/src/sports-service.js";

const FAKE_DB = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const CTX = { actorUserId: "user-a", requestId: "req-1", chatSessionId: "chat-1" };

function makeFakeWriter(): SportsFollowsWriter {
  const rows: SportsFollowDto[] = [];
  return {
    async list() {
      return rows;
    },
    async setSourceTeamId(_db: DataContextDb, id: string, sourceTeamId: string) {
      const row = rows.find((r) => r.id === id);
      if (!row || row.teamKey === null) return undefined;
      const updated: SportsFollowDto = { ...row, sourceTeamId };
      rows[rows.indexOf(row)] = updated;
      return updated;
    },
    async create(_db: DataContextDb, input: CreateSportsFollowInput) {
      const teamKey = input.teamKey ?? null;
      const sourceTeamId = input.sourceTeamId ?? null;
      const existing = rows.find(
        (r) =>
          r.competitionKey === input.competitionKey &&
          (sourceTeamId === null ? r.teamKey === teamKey : r.sourceTeamId === sourceTeamId)
      );
      if (existing) return existing;
      const created: SportsFollowDto = {
        id: `f-${rows.length + 1}`,
        competitionKey: input.competitionKey,
        teamKey,
        sourceTeamId,
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
          // Since review round 5 a follow is saved by the provider's permanent team number, so a
          // roster stand-in has to supply one or the save is refused.
          sourceTeamId: `id-${teamKey}`,
          abbreviation: teamKey
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
    expect(sources.removeSource).toHaveBeenCalledWith(FAKE_DB, source.id, {
      actorUserId: CTX.actorUserId,
      requestId: CTX.requestId
    });
  });

  it("deletes the source's stored photos when the source is removed in chat (#2237)", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "sports-chat-photos-"));
    try {
      const url = "https://images.publisher.example/story.jpg";
      const body = await sharp({
        create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 20, b: 30 } }
      })
        .jpeg()
        .toBuffer();
      const photos = new SportsPhotoStore({
        vault: new VaultContextRunner(baseDir),
        fetchBytes: async () => ({ ok: true, contentType: "image/jpeg", body, truncated: false })
      });
      const access = { actorUserId: CTX.actorUserId, requestId: CTX.requestId };
      await photos.ensure(access, "source-1", url);
      const photoDir = join(baseDir, CTX.actorUserId, "sports", "photos");
      expect(await readdir(photoDir)).toHaveLength(2);

      const service = new SportsSourceService({
        sources: { remove: async () => true },
        photos
      } as never);
      configureSportsChatTools(makeFakeDatasetClient(), makeFakeWriter(), {
        listSources: async () => [{ id: "source-1" }],
        removeSource: service.removeSource.bind(service)
      } as never);

      await expect(callTool(sportsRemoveSourceExecute, { sourceId: "source-1" })).resolves.toEqual({
        data: { removed: true }
      });

      expect(await readdir(photoDir)).toHaveLength(0);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
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
