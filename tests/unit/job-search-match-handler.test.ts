// tests/unit/job-search-match-handler.test.ts
//
// Task 15 (#1299): matches.list (the board's only read route, `risk: "read"`, called with
// `invokeTool` directly from the browser) and match.set-state (one handler, two shapes — a
// manual-run queue envelope from the board, or a tool call from the assistant's
// `job-search.match.dismiss`, which always sets `state: "dismissed"`).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { renderToolResult } from "@moss/module-sdk";
import type { JsonSchema } from "@moss/module-sdk";
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";
import { sanitizeAssistantToolResult } from "../../packages/ai/src/gateway/output-validation.js";

import {
  COMPANY_MAX_CHARS,
  createMatchesCountHandler,
  createMatchesListHandler,
  createMatchGetHandler,
  createMatchSetStateHandler,
  SETTABLE_STATES,
  TITLE_MAX_CHARS,
  URL_MAX_CHARS,
  LOCATION_MAX_CHARS,
  SOURCE_LABEL_MAX_CHARS
} from "../../external-modules/job-search/src/worker/handlers/matches.js";
// N43: MATCHES_LIST_MAX_LIMIT lives in domain/records.ts now — one definition, imported by the
// worker handler, board.tsx, and this test, none of them a second literal.
import {
  BODY_MAX_CHARS,
  MATCHES_LIST_MAX_LIMIT,
  type Match,
  type Posting
} from "../../external-modules/job-search/src/domain/records.js";
import type { JobSearchStore } from "../../external-modules/job-search/src/domain/store-port.js";
import type { FetchLike } from "../../external-modules/job-search/src/adapters/types.js";

// N39 removed `REASON_MAX_CHARS` from matches.ts entirely — there is no longer a row-level
// reason cap to import. `MatchDetail` is deliberately untruncated, so these tests use a plain,
// arbitrarily-large local length to prove "longer than any cap that used to exist" without
// depending on a constant the production code no longer has a reason to define.
const LONG_REASON_LENGTH = 400;

function notUsed(name: string) {
  return async () => {
    throw new Error(`FakeStore.${name} should not be called`);
  };
}

function createFakeStore(input: {
  matches?: Match[];
  postings?: Posting[];
  // Defaults to a lookup against `matches` by id — enough for the common "found" case. Tests
  // exercising a not-found path (wrong id, wrong owner, a synthetic unscored id) override this
  // directly rather than contorting `matches` to produce a miss.
  getMatchImpl?: (matchId: string) => Promise<Match | null>;
}): JobSearchStore & {
  __listMatchesCalls: Array<{ profileId: string; limit: number; offset: number }>;
  __setMatchStateCalls: Array<{ matchId: string; state: Match["state"] }>;
  __getMatchCalls: string[];
  __countMatchesCalls: string[];
  __upsertPostingsCalls: Array<{ profileId: string; postings: Posting[] }>;
} {
  const matches = input.matches ?? [];
  const postingsById = new Map((input.postings ?? []).map((posting) => [posting.id, posting]));
  const listMatchesCalls: Array<{ profileId: string; limit: number; offset: number }> = [];
  const setMatchStateCalls: Array<{ matchId: string; state: Match["state"] }> = [];
  const getMatchCalls: string[] = [];
  const countMatchesCalls: string[] = [];
  const upsertPostingsCalls: Array<{ profileId: string; postings: Posting[] }> = [];
  const getMatchImpl =
    input.getMatchImpl ??
    (async (matchId: string) => matches.find((match) => match.id === matchId) ?? null);

  return {
    listProfiles: vi.fn(notUsed("listProfiles")),
    getProfile: vi.fn(notUsed("getProfile")),
    createProfile: vi.fn(notUsed("createProfile")),
    renameProfile: vi.fn(notUsed("renameProfile")),
    updateCriteria: vi.fn(notUsed("updateCriteria")),
    claimCriteriaRescore: vi.fn(async () => []),
    finishCriteriaRescore: vi.fn(async () => undefined),
    setProfileState: vi.fn(notUsed("setProfileState")),
    setProfileContext: vi.fn(notUsed("setProfileContext")),
    setBriefingDetail: vi.fn(notUsed("setBriefingDetail")),
    listPortals: vi.fn(notUsed("listPortals")),
    setPortalState: vi.fn(notUsed("setPortalState")),
    upsertPostings: vi.fn(async (profileId: string, postings: readonly Posting[]) => {
      const copied = postings.map((posting) => ({ ...posting }));
      upsertPostingsCalls.push({ profileId, postings: copied });
      for (const posting of copied) postingsById.set(posting.id, posting);
      return copied;
    }),
    setEmbedding: vi.fn(notUsed("setEmbedding")),
    listUnscored: vi.fn(notUsed("listUnscored")),
    listUnscoredPostingsWithEmbeddings: vi.fn(notUsed("listUnscoredPostingsWithEmbeddings")),
    // Slices the way the real SQL does. It matters here rather than being fixture pedantry: the
    // handler asks for one row more than the page so it can answer `hasMore` without a COUNT, and a
    // fake that ignored `limit` would report `hasMore: true` on a single-page board — or hide the
    // opposite bug — while still passing every assertion about the rows themselves.
    listMatches: vi.fn(async (profileId: string, limit: number, offset: number) => {
      listMatchesCalls.push({ profileId, limit, offset });
      return matches.slice(offset, offset + limit);
    }),
    // Counts from the same fixture `listMatches` pages, so a test can assert the two agree — the
    // count is what the board's poll watches, and a count that disagreed with the rows would make
    // the poll either miss a finished search or never call one finished.
    countMatches: vi.fn(async (profileId: string) => {
      countMatchesCalls.push(profileId);
      const active = matches.filter((match) => match.state !== "dismissed");
      return {
        active: active.length,
        scored: active.filter((match) => match.state !== "unscored" && match.want !== null).length
      };
    }),
    upsertMatch: vi.fn(notUsed("upsertMatch")),
    setMatchState: vi.fn(async (matchId: string, state: Match["state"]) => {
      setMatchStateCalls.push({ matchId, state });
    }),
    getMatch: vi.fn(async (matchId: string) => {
      getMatchCalls.push(matchId);
      return getMatchImpl(matchId);
    }),
    getLatestResume: vi.fn(notUsed("getLatestResume")),
    getResumeVersion: vi.fn(notUsed("getResumeVersion")),
    setResume: vi.fn(notUsed("setResume")),
    listUnfittedPostingsWithEmbeddings: vi.fn(notUsed("listUnfittedPostingsWithEmbeddings")),
    getSweepCursor: vi.fn(notUsed("getSweepCursor")),
    setSweepCursor: vi.fn(notUsed("setSweepCursor")),
    listCustomSources: vi.fn(notUsed("listCustomSources")),
    addCustomSource: vi.fn(notUsed("addCustomSource")),
    removeCustomSource: vi.fn(notUsed("removeCustomSource")),
    getPostings: vi.fn(async (ids: readonly string[]) => {
      const result = new Map<string, Posting>();
      for (const id of ids) {
        const posting = postingsById.get(id);
        if (posting !== undefined) result.set(id, posting);
      }
      return result;
    }),
    __listMatchesCalls: listMatchesCalls,
    __setMatchStateCalls: setMatchStateCalls,
    __getMatchCalls: getMatchCalls,
    __countMatchesCalls: countMatchesCalls,
    __upsertPostingsCalls: upsertPostingsCalls
  } as JobSearchStore & {
    __listMatchesCalls: Array<{ profileId: string; limit: number; offset: number }>;
    __setMatchStateCalls: Array<{ matchId: string; state: Match["state"] }>;
    __getMatchCalls: string[];
    __countMatchesCalls: string[];
    __upsertPostingsCalls: Array<{ profileId: string; postings: Posting[] }>;
  };
}

function makePosting(id: string, overrides: Partial<Posting> = {}): Posting {
  return {
    id,
    sourceId: "freehire",
    externalId: id,
    title: "Staff Engineer",
    company: "Acme",
    location: "Remote",
    url: `https://example.com/${id}`,
    body: "Description",
    postedAt: null,
    ...overrides
  };
}

function makeMatch(overrides: Partial<Match> = {}): Match {
  return {
    id: "match-1",
    profileId: "profile-1",
    postingId: "post-1",
    fit: 80,
    want: 70,
    fitReason: "Fits well.",
    wantReason: "Wants it.",
    outsideFrame: false,
    state: "new",
    scoredAt: "2026-07-27T00:00:00.000Z",
    ...overrides
  };
}

function toolCtx(
  input: Record<string, unknown>,
  overrides: Partial<ModuleWorkerContext> = {}
): ModuleWorkerContext {
  return {
    input: { ...input, actorUserId: "user-1" },
    deadlineAt: Date.now() + 30_000,
    kv: {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([])
    },
    ...overrides
  } as unknown as ModuleWorkerContext;
}

function unusedFetch(): FetchLike {
  return vi.fn(async () => {
    throw new Error("fetch should not be called");
  });
}

function queueCtx(params: Record<string, unknown>): ModuleWorkerContext {
  return {
    input: {
      actorUserId: "user-1",
      jobKind: "job-search.match-state",
      idempotencyKey: "idem-1",
      params
    }
  } as unknown as ModuleWorkerContext;
}

// The REAL shipped manifest, not a hand-copied schema literal — a test that re-typed the
// outputSchema here would pass even while the actual jarvis.module.json drifted, which is
// exactly the bug this test exists to catch (location/source/postedAt were added to the handler
// in 1a7b9371 but the manifest's outputSchema was never updated, so
// packages/ai/src/routes.ts's `sanitizeAssistantToolResult(manifestTool.outputSchema, toolResult)`
// silently stripped all three back off on the real HTTP path while every handler-level test —
// which calls the handler directly and never touches the manifest — stayed green).
const manifestPath = fileURLToPath(
  new URL("../../external-modules/job-search/jarvis.module.json", import.meta.url)
);
function shippedOutputSchema(toolName: string): JsonSchema {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    assistantTools: Array<{ name: string; outputSchema?: JsonSchema }>;
  };
  const tool = manifest.assistantTools.find((t) => t.name === toolName);
  if (!tool?.outputSchema) {
    throw new Error(`${toolName} has no outputSchema in the shipped manifest`);
  }
  return tool.outputSchema;
}
function matchesListOutputSchema(): JsonSchema {
  return shippedOutputSchema("job-search.matches.list");
}
function matchesCountOutputSchema(): JsonSchema {
  return shippedOutputSchema("job-search.matches.count");
}

describe("createMatchesListHandler", () => {
  it("test 1: no limit throws and does not default; same for 0, 101, and 1.5", async () => {
    const store = createFakeStore({});
    const handler = createMatchesListHandler(store);

    await expect(handler(toolCtx({ profileId: "profile-1" }))).rejects.toThrow(/limit/);
    await expect(handler(toolCtx({ profileId: "profile-1", limit: 0 }))).rejects.toThrow(/limit/);
    await expect(handler(toolCtx({ profileId: "profile-1", limit: 101 }))).rejects.toThrow(/limit/);
    await expect(handler(toolCtx({ profileId: "profile-1", limit: 1.5 }))).rejects.toThrow(/limit/);
    expect(store.listMatches).not.toHaveBeenCalled();
  });

  it("rejects a limit above the render-survival cap", async () => {
    const store = createFakeStore({});
    const handler = createMatchesListHandler(store);

    await expect(
      handler(toolCtx({ profileId: "profile-1", limit: MATCHES_LIST_MAX_LIMIT + 1 }))
    ).rejects.toThrow(/limit/);
    await expect(
      handler(toolCtx({ profileId: "profile-1", limit: MATCHES_LIST_MAX_LIMIT }))
    ).resolves.toBeDefined();
  });

  it("test 2: profileId and limit reach the store unchanged, plus one row to answer hasMore", async () => {
    const store = createFakeStore({ matches: [], postings: [] });
    const handler = createMatchesListHandler(store);

    await handler(toolCtx({ profileId: "profile-77", limit: 12 }));

    // 13, not 12, and that is deliberate: the extra row is how `hasMore` is answered without a
    // second COUNT query, and it is sliced off before anything is returned, so the render budget
    // still only ever sees `limit` rows. An offset the caller did not send defaults to the first
    // page — the assistant calls this tool too, and page one is the only thing a model ever means.
    expect(store.__listMatchesCalls).toEqual([{ profileId: "profile-77", limit: 13, offset: 0 }]);
  });

  it("pages: offset reaches the store, and hasMore says whether another page exists", async () => {
    // The board is read a page at a time (web/read-board.ts) because one browser response can only
    // carry ~25 rows past the assistant render cap. `hasMore` is the whole stopping condition for
    // that walk, and it cannot be inferred from a short page: the handler skips a match whose
    // posting has since been removed, so a page can come back short without being the last one.
    const matches = Array.from({ length: 5 }, (_unused, index) =>
      makeMatch({ id: `match-${index}`, postingId: `post-${index}`, fit: 70, want: 60 })
    );
    const postings = Array.from({ length: 5 }, (_unused, index) => makePosting(`post-${index}`));
    const store = createFakeStore({ matches, postings });
    const handler = createMatchesListHandler(store);

    const first = (await handler(toolCtx({ profileId: "profile-1", limit: 2, offset: 0 }))) as {
      items: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(first.items.map((item) => item.id)).toEqual(["match-0", "match-1"]);
    expect(first.hasMore).toBe(true);

    const last = (await handler(toolCtx({ profileId: "profile-1", limit: 2, offset: 4 }))) as {
      items: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(last.items.map((item) => item.id)).toEqual(["match-4"]);
    expect(last.hasMore).toBe(false);

    expect(store.__listMatchesCalls).toEqual([
      { profileId: "profile-1", limit: 3, offset: 0 },
      { profileId: "profile-1", limit: 3, offset: 4 }
    ]);
  });

  it("pages: a present-but-invalid offset throws rather than quietly reading page one", async () => {
    // Silently correcting it would hand back page one while the caller believed it had page four,
    // which reads as a board that repeats itself rather than as a failure.
    const store = createFakeStore({ matches: [], postings: [] });
    const handler = createMatchesListHandler(store);

    for (const offset of [-1, 1.5, "3"]) {
      await expect(handler(toolCtx({ profileId: "profile-1", limit: 10, offset }))).rejects.toThrow(
        /offset/
      );
    }
    expect(store.__listMatchesCalls).toEqual([]);
  });

  it("test 5: returns board records, never a raw store row — assert the exact keys", async () => {
    const match = makeMatch({ id: "match-1", postingId: "post-1", fit: 80, want: 70 });
    const posting = makePosting("post-1", { title: "Staff Engineer", company: "Acme" });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const handler = createMatchesListHandler(store);

    const result = (await handler(toolCtx({ profileId: "profile-1", limit: 10 }))) as {
      items: Array<Record<string, unknown>>;
    };

    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    // N39: no fitReason/wantReason on the row — board.tsx never renders them. If this still
    // passes with a reason key present, N39 hasn't actually landed. `location`/`source`/`postedAt`
    // are here because the card DOES render each of them, which is the same rule pointing the
    // other way; they were added against the render-cap budget, not on top of it (see the
    // worst-case render-survival test below, which is what actually holds the line).
    expect(Object.keys(item).sort()).toEqual(
      [
        "company",
        "fit",
        "id",
        "location",
        "outsideFrame",
        "postedAt",
        "source",
        "state",
        "title",
        "url",
        "want"
      ].sort()
    );
    expect(item).toEqual({
      id: "match-1",
      title: "Staff Engineer",
      company: "Acme",
      fit: 80,
      want: 70,
      outsideFrame: false,
      state: "new",
      url: "https://example.com/post-1",
      location: "Remote",
      // The source LABEL, not the raw `sourceId` the posting carries — the row is what the card
      // renders, and "freehire" is a key, not a name a reader should be shown.
      source: "freehire.me",
      postedAt: null
    });
    // Never the blended field the product invariant forbids anywhere, including tool results.
    expect(item).not.toHaveProperty("overall");
    expect(item).not.toHaveProperty("combinedScore");
    expect(item).not.toHaveProperty("matchScore");
    expect(item).not.toHaveProperty("rank");
    // N39: reasons are detail-only now, not merely truncated to nothing on the row.
    expect(item).not.toHaveProperty("fitReason");
    expect(item).not.toHaveProperty("wantReason");
  });

  it("survives the manifest's real outputSchema with location/source/postedAt intact — the exact bug this task fixed", async () => {
    // Test 5 above proves the handler ITSELF returns the three fields. That is necessary but not
    // sufficient: the REST path (routes.ts:711) runs the handler's result through
    // `sanitizeAssistantToolResult(manifestTool.outputSchema, toolResult)` before it ever reaches
    // the wire, and that function reconstructs the object from ONLY the keys the manifest
    // declares (output-validation.ts's `sanitizeToolOutputObject` — an allow-list, not a filter).
    // A manifest outputSchema that still lists only the pre-K9 eight fields would pass every test
    // above while silently dropping location/source/postedAt on the real HTTP response, which is
    // exactly what shipped: the handler was fixed in 1a7b9371, the manifest was not.
    const match = makeMatch({ id: "match-1", postingId: "post-1", fit: 80, want: 70 });
    const posting = makePosting("post-1", {
      title: "Staff Engineer",
      company: "Acme",
      location: "Remote",
      sourceId: "freehire",
      postedAt: "2026-07-15T09:00:00.000Z"
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const handler = createMatchesListHandler(store);

    const result = await handler(toolCtx({ profileId: "profile-1", limit: 10 }));
    const sanitized = sanitizeAssistantToolResult(matchesListOutputSchema(), { data: result });
    const items = (sanitized.data as { items: Array<Record<string, unknown>> }).items;

    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      id: "match-1",
      title: "Staff Engineer",
      company: "Acme",
      fit: 80,
      want: 70,
      outsideFrame: false,
      state: "new",
      url: "https://example.com/post-1",
      location: "Remote",
      source: "freehire.me",
      postedAt: "2026-07-15T09:00:00.000Z"
    });
  });

  it("skips a match whose posting has since been removed, rather than throwing", async () => {
    const match = makeMatch({ id: "match-1", postingId: "post-gone" });
    const store = createFakeStore({ matches: [match], postings: [] });
    const handler = createMatchesListHandler(store);

    const result = (await handler(toolCtx({ profileId: "profile-1", limit: 10 }))) as {
      items: unknown[];
    };

    expect(result.items).toEqual([]);
  });

  it("drops a row whose posting has an empty location, logs the match id and the field name, never the posting content", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const match = makeMatch({ id: "match-1", postingId: "post-1" });
      const posting = makePosting("post-1", {
        title: "Confidential Role Title",
        company: "Confidential Co",
        location: "",
        url: "https://example.com/confidential-posting"
      });
      const store = createFakeStore({ matches: [match], postings: [posting] });
      const handler = createMatchesListHandler(store);

      const result = (await handler(toolCtx({ profileId: "profile-1", limit: 10 }))) as {
        items: unknown[];
      };

      expect(result.items).toEqual([]);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const message = consoleErrorSpy.mock.calls[0]![0] as string;
      expect(message).toContain("match-1");
      expect(message).toContain("location");
      expect(message).not.toContain("Confidential Role Title");
      expect(message).not.toContain("Confidential Co");
      expect(message).not.toContain("confidential-posting");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("worst case render-survival: MATCHES_LIST_MAX_LIMIT matches with every field maxed stay <=80% of the tool-result render cap", async () => {
    // packages/ai/src/routes.ts's boundedAssistantToolResultData substitutes {text: "…truncated"}
    // past 16 000 RENDERED characters — and `renderToolResult` (module-sdk) renders a uniform
    // flat array of scalars as a markdown table, not JSON.stringify. Past that cap the board has
    // nothing to render at all, not a short list, so this drives every text field the row still
    // carries post-N39 (the posting's title/company — which this module doesn't control the
    // length of — and #1330's `url`; NOT fitReason/wantReason, which N39 removed from the row
    // entirely) to its cap and checks the REAL render function, not an approximation of it.
    // Targets <=80% (12 800), not merely under 16 000, per N38: a field added later must not
    // silently blow the budget with no headroom to notice it in a diff.
    const MAX_RENDERED_TOOL_RESULT_CHARS = 16_000;
    const RENDER_HEADROOM_TARGET = MAX_RENDERED_TOOL_RESULT_CHARS * 0.8;
    const longTitle = "t".repeat(TITLE_MAX_CHARS + 200);
    const longCompany = "c".repeat(COMPANY_MAX_CHARS + 200);
    const longUrl = `https://example.com/${"u".repeat(URL_MAX_CHARS + 200)}`;
    // The card's meta line is driven here too — a budget test that maxes only the fields that
    // existed when it was written stops being a budget test the moment a field is added.
    const longLocation = "l".repeat(LOCATION_MAX_CHARS + 200);
    const longSourceId = "s".repeat(SOURCE_LABEL_MAX_CHARS + 200);
    const matches = Array.from({ length: MATCHES_LIST_MAX_LIMIT }, (_, i) =>
      makeMatch({
        id: `match-${i}`,
        postingId: `post-${i}`,
        outsideFrame: true,
        state: "dismissed"
      })
    );
    const postings = Array.from({ length: MATCHES_LIST_MAX_LIMIT }, (_, i) =>
      makePosting(`post-${i}`, {
        title: longTitle,
        company: longCompany,
        url: longUrl,
        location: longLocation,
        sourceId: longSourceId,
        postedAt: "2026-07-15T09:00:00.000Z"
      })
    );
    const store = createFakeStore({ matches, postings });
    const handler = createMatchesListHandler(store);

    const result = (await handler(
      toolCtx({ profileId: "profile-1", limit: MATCHES_LIST_MAX_LIMIT })
    )) as Record<string, unknown>;

    const rendered = renderToolResult({ data: result });
    expect(rendered.length).toBeLessThan(MAX_RENDERED_TOOL_RESULT_CHARS);
    expect(rendered.length).toBeLessThanOrEqual(RENDER_HEADROOM_TARGET);
  });

  it("N39 ceiling: the real <=80% row-count boundary for the reason-free row is 30, not 31", async () => {
    // Pins the arithmetic behind matches.ts's N39 comment as a committed test, not just a scratch
    // script's output. `MATCHES_LIST_MAX_LIMIT` is intentionally held below this boundary (15 for
    // now, 25 once `board.tsx` is synced in the same commit — see the constant's own comment) —
    // this test proves the boundary itself so a future change to title/company/url's caps, or to
    // the chosen limit, is checked against the real ceiling rather than a remembered number.
    const MAX_RENDERED_TOOL_RESULT_CHARS = 16_000;
    const RENDER_HEADROOM_TARGET = MAX_RENDERED_TOOL_RESULT_CHARS * 0.8;
    const longTitle = "t".repeat(TITLE_MAX_CHARS);
    const longCompany = "c".repeat(COMPANY_MAX_CHARS);
    const longUrl = `https://example.com/${"u".repeat(URL_MAX_CHARS - "https://example.com/".length)}`;

    // Real match ids are Postgres uuids (36 chars) — matters here because id is unbounded and
    // this test is about the real byte budget, not the short fixture ids `makeMatch` defaults to.
    function uuidShaped(i: number): string {
      return `${i}`.padStart(8, "0") + "-aaaa-bbbb-cccc-" + `${i}`.padStart(12, "0");
    }
    function renderAt(limit: number): string {
      const matches = Array.from({ length: limit }, (_, i) =>
        makeMatch({
          id: uuidShaped(i),
          postingId: `post-${i}`,
          outsideFrame: true,
          state: "dismissed"
        })
      );
      const postings = Array.from({ length: limit }, (_, i) =>
        makePosting(`post-${i}`, { title: longTitle, company: longCompany, url: longUrl })
      );
      return renderToolResult({
        data: { items: matches.map((match, i) => toBoardShape(match, postings[i]!)) }
      });
    }
    function toBoardShape(match: Match, posting: Posting) {
      return {
        id: match.id,
        title: posting.title.slice(0, TITLE_MAX_CHARS),
        company: posting.company.slice(0, COMPANY_MAX_CHARS),
        fit: match.fit,
        want: match.want,
        outsideFrame: match.outsideFrame,
        state: match.state,
        url: posting.url.slice(0, URL_MAX_CHARS)
      };
    }

    expect(renderAt(30).length).toBeLessThanOrEqual(RENDER_HEADROOM_TARGET);
    expect(renderAt(31).length).toBeGreaterThan(RENDER_HEADROOM_TARGET);
  });
});

// The board's change detector. It exists because matches.list is paged at 25 rows, and the search
// poll was answering "is anything still arriving?" by re-reading every page every six seconds —
// about eighty requests a minute against a host budget of sixty shared by every module read tool in
// the app, which earned 429s mid-crawl. Its contract is therefore about cost and agreement: one
// request at any board size, and a number that matches the rows matches.list would page.
describe("createMatchesCountHandler", () => {
  it("rejects an unknown key", async () => {
    const store = createFakeStore({});
    const handler = createMatchesCountHandler(store);

    await expect(handler(toolCtx({ profileId: "profile-1", limit: 25 }))).rejects.toThrow(
      /unknown key: limit/
    );
    expect(store.countMatches).not.toHaveBeenCalled();
  });

  it("rejects a missing profileId", async () => {
    const store = createFakeStore({});
    const handler = createMatchesCountHandler(store);

    await expect(handler(toolCtx({}))).rejects.toThrow();
    expect(store.countMatches).not.toHaveBeenCalled();
  });

  it("echoes the profile it counted, so a caller switching profiles can attribute the answer", async () => {
    const store = createFakeStore({ matches: [makeMatch({ id: "match-1" })] });
    const handler = createMatchesCountHandler(store);

    const result = await handler(toolCtx({ profileId: "profile-1" }));

    expect(result).toEqual({ profileId: "profile-1", active: 1, scored: 1 });
    expect(store.__countMatchesCalls).toEqual(["profile-1"]);
  });

  it("counts one request's worth regardless of board size — never one per page", async () => {
    // Four pages of rows. The old poll would have spent four requests to learn this number.
    const matches = Array.from({ length: MATCHES_LIST_MAX_LIMIT * 4 }, (_, i) =>
      makeMatch({ id: `match-${i}`, postingId: `post-${i}` })
    );
    const store = createFakeStore({ matches });
    const handler = createMatchesCountHandler(store);

    const result = (await handler(toolCtx({ profileId: "profile-1" }))) as { active: number };

    expect(result.active).toBe(MATCHES_LIST_MAX_LIMIT * 4);
    expect(store.countMatches).toHaveBeenCalledTimes(1);
    expect(store.listMatches).not.toHaveBeenCalled();
  });

  it("excludes dismissed rows from active, matching what the board renders", async () => {
    const store = createFakeStore({
      matches: [
        makeMatch({ id: "match-1", state: "new" }),
        makeMatch({ id: "match-2", postingId: "post-2", state: "dismissed" })
      ]
    });
    const handler = createMatchesCountHandler(store);

    const result = await handler(toolCtx({ profileId: "profile-1" }));

    // A counter that included dismissed rows would disagree with the number rendered beside it.
    expect(result).toEqual({ profileId: "profile-1", active: 1, scored: 1 });
  });

  it("counts a match scored before a résumé existed as scored — Fit is not part of the test", async () => {
    // `isScored` in web/board-types.ts is keyed on Want alone, deliberately: every row on a board
    // with no résumé on file has a real Want and an empty Fit, and those rows are read and judged.
    // If `scored` disagreed, the poll would treat a finished search as still working.
    const store = createFakeStore({
      matches: [
        makeMatch({ id: "match-1", fit: null, want: 70, state: "new" }),
        makeMatch({ id: "match-2", postingId: "post-2", want: null, state: "unscored" })
      ]
    });
    const handler = createMatchesCountHandler(store);

    const result = await handler(toolCtx({ profileId: "profile-1" }));

    expect(result).toEqual({ profileId: "profile-1", active: 2, scored: 1 });
  });

  it("survives the shipped manifest's own outputSchema, and cannot be truncated away", async () => {
    const store = createFakeStore({ matches: [makeMatch({ id: "match-1" })] });
    const result = await createMatchesCountHandler(store)(toolCtx({ profileId: "profile-1" }));

    // Against the REAL manifest, not a re-typed literal: every field the browser reads has to be
    // declared `required` there or the host's sanitiser strips it on the HTTP path, and the poll
    // then compares against `undefined` for ever while every handler-level test stays green.
    const sanitized = sanitizeAssistantToolResult(matchesCountOutputSchema(), { data: result });
    expect(sanitized.data).toEqual({ profileId: "profile-1", active: 1, scored: 1 });

    // Two integers, so this is the one board read the 16 000-character render cap cannot reach —
    // which is precisely why the poll can lean on it at any board size.
    expect(renderToolResult(sanitized).length).toBeLessThan(400);
  });
});

describe("createMatchGetHandler", () => {
  it("rejects an unknown key", async () => {
    const store = createFakeStore({});
    const handler = createMatchGetHandler(store, unusedFetch());

    await expect(handler(toolCtx({ matchId: "match-1", extra: 1 }))).rejects.toThrow(
      /unknown key: extra/
    );
    expect(store.getMatch).not.toHaveBeenCalled();
  });

  it("requires matchId", async () => {
    const store = createFakeStore({});
    const handler = createMatchGetHandler(store, unusedFetch());

    await expect(handler(toolCtx({}))).rejects.toThrow(/matchId is required/);
    expect(store.getMatch).not.toHaveBeenCalled();
  });

  it("returns the untruncated detail for a found match, including the posting url — assert the exact keys", async () => {
    const longReason = "x".repeat(LONG_REASON_LENGTH);
    const match = makeMatch({
      id: "match-1",
      postingId: "post-1",
      fitReason: longReason,
      wantReason: longReason
    });
    const posting = makePosting("post-1", { title: "Staff Engineer", company: "Acme" });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch = unusedFetch();
    const handler = createMatchGetHandler(store, fetch);

    const result = (await handler(toolCtx({ matchId: "match-1" }))) as {
      match: Record<string, unknown>;
    };

    expect(store.__getMatchCalls).toEqual(["match-1"]);
    expect(fetch).not.toHaveBeenCalled();
    // Pinned separately from matches.ts's BoardMatch key list (test 5, above): the two shapes
    // diverge on purpose. If MatchDetail ever grows a truncateText call, or loses a reason key
    // to match BoardMatch, this fails loudly rather than silently.
    expect(Object.keys(result.match).sort()).toEqual(
      [
        "company",
        "body",
        "fit",
        "fitReason",
        "id",
        "outsideFrame",
        "scoredAt",
        "state",
        "title",
        "url",
        "want",
        "wantReason"
      ].sort()
    );
    // The whole point of this handler: a reason far longer than any cap that ever existed on the
    // row path comes back whole, proving this is a genuinely different read path from
    // matches.list, not the same truncation reapplied. If a truncateText call is reintroduced
    // here, this assertion — not just a length check — catches it.
    expect(result).toEqual({
      matchId: "match-1",
      match: {
        id: "match-1",
        title: "Staff Engineer",
        company: "Acme",
        url: "https://example.com/post-1",
        body: "Description",
        fit: 80,
        want: 70,
        fitReason: longReason,
        wantReason: longReason,
        outsideFrame: false,
        scoredAt: "2026-07-27T00:00:00.000Z",
        state: "new"
      }
    });
  });

  it("returns match: null for an id the store doesn't resolve (wrong owner, deleted, or a synthetic unscored id)", async () => {
    const store = createFakeStore({ getMatchImpl: async () => null });
    const handler = createMatchGetHandler(store, unusedFetch());

    const result = await handler(toolCtx({ matchId: "post-42" }));

    expect(result).toEqual({ matchId: "post-42", match: null });
  });

  it("returns match: null when the match's posting has since been removed", async () => {
    const match = makeMatch({ id: "match-1", postingId: "post-gone" });
    const store = createFakeStore({ matches: [match], postings: [] });
    const handler = createMatchGetHandler(store, unusedFetch());

    const result = await handler(toolCtx({ matchId: "match-1" }));

    expect(result).toEqual({ matchId: "match-1", match: null });
  });

  it("keeps the worst-case detail below the rendered-result cap", async () => {
    const match = makeMatch({
      id: "00000001-aaaa-bbbb-cccc-000000000001",
      postingId: "post-1",
      fitReason: "f".repeat(600),
      wantReason: "w".repeat(600),
      outsideFrame: true,
      state: "dismissed"
    });
    const posting = makePosting("post-1", {
      title: "t".repeat(TITLE_MAX_CHARS + 200),
      company: "c".repeat(COMPANY_MAX_CHARS + 200),
      url: `https://example.com/${"u".repeat(URL_MAX_CHARS + 200)}`,
      body: "b".repeat(BODY_MAX_CHARS + 200)
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });

    const result = (await createMatchGetHandler(
      store,
      unusedFetch()
    )(toolCtx({ matchId: match.id }))) as Record<string, unknown> & { match: { body: string } };
    const rendered = renderToolResult({ data: result });

    expect(result.match.body).toHaveLength(BODY_MAX_CHARS);
    expect(rendered.length).toBeLessThanOrEqual(12_800);
  });

  it("replaces a legacy LinkedIn benefits badge with the fetched description", async () => {
    const match = makeMatch();
    const posting = makePosting("post-1", {
      sourceId: "linkedin",
      externalId: "424242",
      body: "Medical insurance\n+2 benefits"
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<div class="show-more-less-html__markup"><p>Build the platform.</p></div>'
    });

    const result = (await createMatchGetHandler(store, fetch)(toolCtx({ matchId: "match-1" }))) as {
      match: { body: string };
    };

    expect(result.match.body).toBe("Build the platform.");
    expect(store.__upsertPostingsCalls).toEqual([
      {
        profileId: "profile-1",
        postings: [{ ...posting, body: "Build the platform." }]
      }
    ]);
  });

  it("does not fetch an empty body from a non-LinkedIn source", async () => {
    const match = makeMatch();
    const posting = makePosting("post-1", { body: "" });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch = unusedFetch();

    const result = (await createMatchGetHandler(store, fetch)(toolCtx({ matchId: "match-1" }))) as {
      match: { body: string };
    };

    expect(result.match.body).toBe("");
    expect(fetch).not.toHaveBeenCalled();
    expect(store.__upsertPostingsCalls).toEqual([]);
  });

  it("returns an empty body, suppresses retries for 24 hours, and leaves portal health alone", async () => {
    const match = makeMatch();
    const posting = makePosting("post-1", {
      sourceId: "linkedin",
      externalId: "424242",
      body: "Medical insurance\n+2 benefits"
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch: FetchLike = vi.fn().mockRejectedValue(new Error("offline"));
    const values = new Map<string, Record<string, unknown>>();
    const kv = {
      get: vi.fn(async (_scope: string, namespace: string, key: string) => {
        return values.get(`${namespace}:${key}`) ?? null;
      }),
      set: vi.fn(
        async (_scope: string, namespace: string, key: string, value: Record<string, unknown>) => {
          values.set(`${namespace}:${key}`, value);
        }
      ),
      delete: vi.fn().mockResolvedValue(false),
      list: vi.fn().mockResolvedValue([])
    };
    const ctx = toolCtx({ matchId: "match-1" }, { kv } as Partial<ModuleWorkerContext>);
    const handler = createMatchGetHandler(store, fetch);

    const first = (await handler(ctx)) as { match: { body: string } };
    const second = (await handler(ctx)) as { match: { body: string } };

    expect(first.match.body).toBe("");
    expect(second.match.body).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(kv.set).toHaveBeenCalledTimes(1);
    expect(store.setPortalState).not.toHaveBeenCalled();
    expect(store.__upsertPostingsCalls).toEqual([]);
  });

  it("times out description enrichment before the invocation deadline", async () => {
    const match = makeMatch();
    const posting = makePosting("post-1", {
      sourceId: "linkedin",
      externalId: "424242",
      body: ""
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch: FetchLike = () => new Promise(() => undefined);
    const ctx = toolCtx({ matchId: "match-1" }, {
      deadlineAt: Date.now() + 1_002
    } as Partial<ModuleWorkerContext>);

    const result = (await createMatchGetHandler(store, fetch)(ctx)) as {
      match: { body: string };
    };

    expect(result.match.body).toBe("");
    expect(ctx.kv.set).toHaveBeenCalledTimes(1);
    expect(store.__upsertPostingsCalls).toEqual([]);
  });

  it("converges harmlessly when two empty-body detail reads race", async () => {
    const match = makeMatch();
    const posting = makePosting("post-1", {
      sourceId: "linkedin",
      externalId: "424242",
      body: ""
    });
    const store = createFakeStore({ matches: [match], postings: [posting] });
    const fetch: FetchLike = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => '<div class="show-more-less-html__markup"><p>Build the platform.</p></div>'
    });
    const handler = createMatchGetHandler(store, fetch);

    const results = (await Promise.all([
      handler(toolCtx({ matchId: "match-1" })),
      handler(toolCtx({ matchId: "match-1" }))
    ])) as Array<{ match: { body: string } }>;

    expect(results.map((result) => result.match.body)).toEqual([
      "Build the platform.",
      "Build the platform."
    ]);
    expect(store.__upsertPostingsCalls).toHaveLength(2);
  });
});

describe("createMatchSetStateHandler", () => {
  it("test 3: state outside the settable set throws and calls the store zero times", async () => {
    const store = createFakeStore({});
    const handler = createMatchSetStateHandler(store);

    await expect(handler(queueCtx({ matchId: "match-1", state: "archived" }))).rejects.toThrow(
      /state must be one of/
    );
    expect(store.setMatchState).not.toHaveBeenCalled();
  });

  it("test 4: each of the three legal states calls the store exactly once with that state", async () => {
    for (const state of SETTABLE_STATES) {
      const store = createFakeStore({});
      const handler = createMatchSetStateHandler(store);

      await handler(queueCtx({ matchId: "match-1", state }));

      expect(store.__setMatchStateCalls).toEqual([{ matchId: "match-1", state }]);
    }
  });

  it("the assistant's dismiss tool shape always sets dismissed, with no state field on its input", async () => {
    const store = createFakeStore({});
    const handler = createMatchSetStateHandler(store);

    const result = await handler(toolCtx({ matchId: "match-9" }));

    expect(result).toEqual({
      matchId: "match-9",
      state: "dismissed",
      statusText: "Role passed"
    });
    expect(store.__setMatchStateCalls).toEqual([{ matchId: "match-9", state: "dismissed" }]);
  });

  it("the dismiss tool shape rejects an unexpected key rather than accepting a caller-supplied state", async () => {
    const store = createFakeStore({});
    const handler = createMatchSetStateHandler(store);

    await expect(handler(toolCtx({ matchId: "match-9", state: "seen" }))).rejects.toThrow(
      /unknown key: state/
    );
    expect(store.setMatchState).not.toHaveBeenCalled();
  });
});
