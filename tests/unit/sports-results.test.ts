import { describe, it, expect, vi } from "vitest";
import type { DatasetClient } from "@moss/datasets";
import {
  parseCompletedResults,
  fetchCompletedResults
} from "../../packages/sports/src/results/espn-results.js";
import { ESPN_IMAGE_HOSTS } from "../../packages/sports/src/source/espn-assets.js";
import { SportsResultReader } from "../../packages/sports/src/results/reader.js";
import {
  sportsResultTemplate,
  readSportsResultSnapshot
} from "../../packages/sports/src/results/contract.js";
import { resultSnapshot } from "../../packages/sports/src/results/tool.js";
import { installBuiltInVisualTemplates, validateVisualCatalogReply } from "@moss/shared";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { sportsPublicReadPresentation } from "../../packages/sports/src/approval-presentation.js";

const window = {
  competitionKey: "eng.1",
  sourceTeamId: "364",
  from: "2026-07-25T12:00:00Z",
  to: "2026-10-23T12:00:00Z"
};
function event(id = "100", date = "2026-10-22T12:00:00Z", name = "STATUS_FULL_TIME") {
  return {
    id,
    date,
    leagues: [{ slug: "eng.1", name: "Premier League" }],
    competitions: [
      {
        status: { type: { completed: true, state: "post", name, detail: "Full Time" } },
        competitors: [
          {
            homeAway: "away",
            team: {
              id: "364",
              displayName: "Liverpool",
              logos: [{ href: "https://a.espncdn.com/i/teamlogos/soccer/500/364.png" }]
            },
            score: { value: 2 }
          },
          {
            homeAway: "home",
            team: { id: "1", displayName: "Opponent", logo: "https://a.espncdn.com/one.png" },
            score: "1"
          }
        ]
      }
    ]
  };
}
const parse = (events: unknown[]) => parseCompletedResults({ events }, window, ESPN_IMAGE_HOSTS);
const result = () => parse([event()])[0]!;

installBuiltInVisualTemplates([sportsResultTemplate]);

describe("completed sports results", () => {
  it("aligns reversed competitors, chooses the newest kickoff and deduplicates stable events", () => {
    const games = parse([event("100", "2026-10-20T12:00:00Z"), event("101"), event("101")]);
    expect(games).toHaveLength(2);
    expect(games[0]).toMatchObject({
      id: "101",
      home: { id: "1", score: 1 },
      away: { id: "364", score: 2 }
    });
  });
  it.each([
    "STATUS_SCHEDULED",
    "STATUS_IN_PROGRESS",
    "STATUS_POSTPONED",
    "STATUS_CANCELED",
    "STATUS_ABANDONED"
  ])("excludes %s even if a provider marks post/completed", (status) => {
    expect(parse([event("100", undefined, status)])).toEqual([]);
  });
  it("requires official completion and a bounded kickoff", () => {
    const live = event();
    live.competitions[0]!.status.type.completed = false;
    expect(
      parse([
        live,
        event("2", "2026-07-24T00:00:00Z"),
        event("3", "bad"),
        event("4", "2026-10-24T00:00:00Z")
      ])
    ).toEqual([]);
  });
  it("keeps nulls, draws, shootouts and aggregates separate, and omits absent scorers", () => {
    const raw = event("100", undefined, "STATUS_FULL_TIME_ET");
    const sides = raw.competitions[0]!.competitors;
    Object.assign(sides[0]!, { score: null, shootoutScore: "4", aggregateScore: 3 });
    Object.assign(sides[1]!, { score: null, shootoutScore: "5", aggregateScore: 3 });
    const parsed = parse([raw])[0]!;
    expect(parsed.home).toMatchObject({ score: null, shootout: 5, aggregate: 3 });
    expect(parsed.away).toMatchObject({ score: null, shootout: 4, aggregate: 3 });
    expect(JSON.stringify(parsed)).not.toContain("scorers");
    Object.assign(sides[0]!, { score: "0" });
    Object.assign(sides[1]!, { score: "0" });
    expect(parse([raw])[0]).toMatchObject({ home: { score: 0 }, away: { score: 0 } });
  });
  it("does not retain API refs and blocks unreviewed assets", () => {
    const raw = event();
    Object.assign(raw, { $ref: "https://private.invalid/secret" });
    raw.competitions[0]!.competitors[1]!.team.logo = "https://unreviewed.invalid/logo.png";
    const parsed = parse([raw])[0]!;
    expect(parsed.home.crestUrl).toBeNull();
    expect(JSON.stringify(parsed)).not.toContain("private.invalid");
    expect(parsed.away.crestUrl).toContain("364.png");
  });
  it("uses only the pinned fetch with the bounded date range", async () => {
    const fetchFn = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ events: [event()] }))
    );
    expect(await fetchCompletedResults(fetchFn, window, ESPN_IMAGE_HOSTS)).toHaveLength(1);
    const url = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(url.hostname).toBe("site.api.espn.com");
    expect(url.searchParams.get("dates")).toBe("20260725-20261023");
    expect(url.pathname).toContain("/teams/364/schedule");
    await expect(
      fetchCompletedResults(fetchFn, { ...window, sourceTeamId: "../1" }, ESPN_IMAGE_HOSTS)
    ).rejects.toThrow("Invalid bounded");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});

function readerFixture(failed = false, empty = false) {
  const getDataset: DatasetClient["getDataset"] = async <T>(
    key: string,
    params: Record<string, unknown>
  ) => ({
    data: (key === "teams"
      ? [{ sourceTeamId: "364", name: "Liverpool", shortName: "Liverpool" }]
      : empty
        ? []
        : [
            {
              ...result(),
              id: params.competitionKey === "eng.1" ? "1" : "2",
              startsAt:
                params.competitionKey === "eng.1" ? "2026-10-20T00:00:00Z" : "2026-10-22T00:00:00Z"
            }
          ]) as T,
    degraded: key === "results" && params.competitionKey === "uefa.champions" && failed,
    fetchedAt: "2026-10-23T12:00:00Z"
  });
  const list = vi.fn(async () =>
    ["eng.1", "uefa.champions"].map((competitionKey) => ({
      id: competitionKey,
      competitionKey,
      sourceTeamId: "364",
      teamKey: "liv",
      createdAt: window.to
    }))
  );
  return {
    reader: new SportsResultReader({ getDataset }, { list }, () => new Date(window.to)),
    list
  };
}

describe("authorized latest available result", () => {
  it("selects a newer cup match across followed covered competitions without a write", async () => {
    const read = await readerFixture().reader.read({} as never, { teamName: "Liverpool" });
    expect(read).toMatchObject({
      status: "result",
      result: { id: "2" },
      competitions: ["uefa.champions", "eng.1"]
    });
    expect(read.status === "result" && read.coverage).toContain(
      "other competitions may be missing"
    );
  });
  it("labels partial coverage and never substitutes an upcoming fixture for an empty window", async () => {
    expect(
      await readerFixture(true).reader.read({} as never, { teamName: "Liverpool" })
    ).toMatchObject({
      status: "result",
      result: { id: "1" },
      failedCompetitions: ["uefa.champions"]
    });
    expect(
      await readerFixture(false, true).reader.read({} as never, { teamName: "Liverpool" })
    ).toMatchObject({ status: "empty", result: null });
  });
  it("asks for context instead of guessing a global men's/women's identity", async () => {
    const reader = new SportsResultReader({ getDataset: vi.fn() }, { list: async () => [] });
    expect(await reader.read({} as never, { teamName: "Liverpool" })).toMatchObject({
      status: "needs_team"
    });
  });
  it("requires a choice when followed rosters contain distinct teams with the same name", async () => {
    const getDataset = vi.fn<DatasetClient["getDataset"]>(async <T>() => ({
      data: [
        { sourceTeamId: "364", name: "Liverpool", shortName: "Liverpool" },
        { sourceTeamId: "999", name: "Liverpool Women", shortName: "Liverpool" }
      ] as T,
      degraded: false,
      fetchedAt: window.to
    }));
    const follows = {
      list: async () =>
        ["364", "999"].map((sourceTeamId) => ({
          id: sourceTeamId,
          competitionKey: "eng.1",
          sourceTeamId,
          teamKey: sourceTeamId,
          createdAt: window.to
        }))
    };
    const reader = new SportsResultReader({ getDataset }, follows);
    expect(await reader.read({} as never, { teamName: "Liverpool" })).toMatchObject({
      status: "ambiguous"
    });
    expect(getDataset).toHaveBeenCalledTimes(1);
    expect(
      await reader.read({} as never, { teamName: "Other", sourceTeamId: "364" })
    ).toMatchObject({ status: "needs_team" });
  });
  it("presents result query fields and rejects extra outbound fields", async () => {
    const present = sportsPublicReadPresentation("results");
    const input = {
      params: {},
      query: { teamName: "Liverpool", competitionKey: "eng.1" },
      body: {}
    };
    expect(await present({} as never, input, ctx as never)).toMatchObject({
      target: "Latest available sports result"
    });
    expect(
      await present(
        {} as never,
        { ...input, query: { ...input.query, url: "https://example.com" } },
        ctx as never
      )
    ).toBeNull();
  });
});

async function snapshot() {
  const read = await readerFixture().reader.read({} as never, { teamName: "Liverpool" });
  if (read.status !== "result") throw new Error("Expected result");
  return resultSnapshot(read)!;
}
const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
const ctx = { ...identity, chatSessionId: "session", requestId: "request" };

describe("source snapshot boundary", () => {
  it("does not present on read; saves only host facts and source-authored fallback", async () => {
    const service = new VisualPresentationService();
    const turn = service.begin("session", identity);
    const source = await snapshot();
    const registration = service.registerSnapshot(ctx, source);
    expect(turn.reply).toBeUndefined();
    if (!registration.ok) throw new Error(registration.code);
    source.fields.home.score = 999;
    const presented = service.present(ctx, {
      catalogVersion: registration.catalogVersion,
      blocks: [{ kind: registration.templateKind, snapshotRefs: [registration.ref] }],
      interactions: []
    });
    if (!presented.ok) throw new Error(presented.code);
    expect(presented.reply.snapshots[0]!.fields.home).toMatchObject({ score: 1 });
    expect(presented.reply.fallbackText).toContain("Opponent 1–2 Liverpool");
    expect(validateVisualCatalogReply(presented.reply).ok).toBe(true);
    const forged = structuredClone(presented.reply);
    forged.snapshots[0]!.fields.home = { arbitrary: "https://example.com" };
    expect(validateVisualCatalogReply(forged).ok).toBe(false);
  });
  it("rejects foreign context and late registration after Stop", async () => {
    const service = new VisualPresentationService();
    const turn = service.begin("session", identity);
    expect(service.registerSnapshot({ ...ctx, threadId: "other" }, await snapshot()).ok).toBe(
      false
    );
    turn.discard();
    expect(service.registerSnapshot(ctx, await snapshot()).ok).toBe(false);
  });
  it("rejects fabricated references and model-authored numeric fields", async () => {
    for (const forged of [false, true]) {
      const service = new VisualPresentationService();
      service.begin("session", identity);
      const registration = service.registerSnapshot(ctx, await snapshot());
      if (!registration.ok) throw new Error(registration.code);
      expect(
        service.present(ctx, {
          catalogVersion: registration.catalogVersion,
          blocks: [
            {
              kind: registration.templateKind,
              snapshotRefs: [forged ? "vs_fabricated" : registration.ref],
              ...(!forged ? { score: 99 } : {})
            }
          ],
          interactions: []
        }).ok
      ).toBe(false);
    }
  });
  it("rejects malformed snapshots and unreviewed image origins", async () => {
    const raw = { ...(await snapshot()), ref: "snapshot" };
    expect(readSportsResultSnapshot(raw)).not.toBeNull();
    for (const url of ["javascript:alert(1)", "https://unreviewed.invalid/logo.png"]) {
      raw.fields.home.crestUrl = url;
      expect(readSportsResultSnapshot(raw)).toBeNull();
    }
  });
});
