// tests/unit/job-search-score-stage.test.ts
//
// Task 15 (#1299): unit tests for the score stage, against an in-memory fake `JobSearchStore`,
// `EmbedPort`, `AiPort`, and `NotifyPort` — no SDK, no network, no model. Every store method is
// a `vi.fn()` so a test can assert which calls did or did not happen, matching Task 14's
// job-search-crawl-stage.test.ts style.
import { describe, expect, it, vi } from "vitest";

import type { EmbedPort } from "../../external-modules/job-search/src/worker/stages/crawl.js";
import {
  AI_CALL_BUDGET,
  runScore,
  type AiPort,
  type NotifyPort
} from "../../external-modules/job-search/src/worker/stages/score.js";
import type { SearchCriteria } from "../../external-modules/job-search/src/domain/records.js";
import type {
  JobSearchStore,
  Profile,
  PostingWithEmbedding,
  Resume,
  Match
} from "../../external-modules/job-search/src/domain/store-port.js";

const PROFILE_ID = "profile-1";
const NOW = "2026-07-27T10:00:00.000Z";

function makeCriteria(overrides: Partial<SearchCriteria> = {}): SearchCriteria {
  return {
    titles: ["Staff Engineer"],
    seniority: ["staff"],
    locations: ["Remote"],
    remote: "preferred",
    compFloorCents: null,
    excludeCompanies: [],
    mustHave: [],
    niceToHave: [],
    dealbreakers: [],
    wantNarrative: "Meaningful work with real autonomy.",
    ...overrides
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    id: PROFILE_ID,
    name: "Default search",
    state: "active",
    criteria: makeCriteria(),
    contextSummary: null,
    schedule: null,
    briefingDetail: "top",
    surfaceKey: "job-search-default",
    createdAt: NOW,
    ...overrides
  };
}

function makePosting(id: string): PostingWithEmbedding {
  return {
    id,
    sourceId: "freehire",
    externalId: id,
    title: "Staff Engineer",
    company: `Company for ${id}`,
    location: "Remote",
    url: `https://example.com/${id}`,
    body: `Full description for ${id}`,
    postedAt: null,
    embedding: [1, 0, 0]
  };
}

/** Every method is a `vi.fn()`. A method `runScore` never touches throws, so a test that
 * accidentally depends on one fails loudly rather than silently returning `undefined`. */
function createFakeStore(input: {
  profile: Profile;
  candidates: PostingWithEmbedding[];
  unfittedCandidates?: PostingWithEmbedding[];
  resume?: Resume;
}): JobSearchStore & { __matches: Match[] } {
  const { profile, candidates, resume } = input;
  const matches: Match[] = [];

  const notUsed = (name: string) => async () => {
    throw new Error(`FakeStore.${name} should not be called by runScore`);
  };

  return {
    listProfiles: vi.fn(notUsed("listProfiles")),
    getProfile: vi.fn(async (id: string) => (id === profile.id ? profile : null)),
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
    upsertPostings: vi.fn(notUsed("upsertPostings")),
    setEmbedding: vi.fn(notUsed("setEmbedding")),
    listUnscored: vi.fn(notUsed("listUnscored")),
    listUnscoredPostingsWithEmbeddings: vi.fn(async () => candidates),
    listMatches: vi.fn(notUsed("listMatches")),
    countMatches: vi.fn(notUsed("countMatches")),
    upsertMatch: vi.fn(async (_profileId: string, match: Omit<Match, "id">) => {
      matches.push({ ...match, id: `match-${matches.length}` });
      return true;
    }),
    setMatchState: vi.fn(notUsed("setMatchState")),
    getMatch: vi.fn(notUsed("getMatch")),
    getLatestResume: vi.fn(async () => resume),
    getResumeVersion: vi.fn(notUsed("getResumeVersion")),
    setResume: vi.fn(notUsed("setResume")),
    listUnfittedPostingsWithEmbeddings: vi.fn(async () => input.unfittedCandidates ?? []),
    getSweepCursor: vi.fn(notUsed("getSweepCursor")),
    setSweepCursor: vi.fn(notUsed("setSweepCursor")),
    listCustomSources: vi.fn(notUsed("listCustomSources")),
    addCustomSource: vi.fn(notUsed("addCustomSource")),
    removeCustomSource: vi.fn(notUsed("removeCustomSource")),
    getPostings: vi.fn(notUsed("getPostings")),
    __matches: matches
  } as JobSearchStore & { __matches: Match[] };
}

function createFakeEmbed(): EmbedPort {
  return {
    embedDocuments: vi.fn(async () => {
      throw new Error(
        "embedDocuments should not be called by runScore — that is the crawl stage's job"
      );
    }),
    embedQuery: vi.fn(async () => [1, 0, 0]),
    dimensions: vi.fn(async () => 3)
  };
}

function createFakeNotify(): NotifyPort & { __posted: Array<{ key: string; body: string }> } {
  const posted: Array<{ key: string; body: string }> = [];
  return {
    post: vi.fn(async (input: { key: string; title: string; body: string }) => {
      posted.push({ key: input.key, body: input.body });
    }),
    __posted: posted
  };
}

const okResult = {
  fit: 80,
  fitDisposition: "supported",
  want: 70,
  fitReason: "Strong match on skills.",
  wantReason: "Team shape fits."
};

/** A queue of responses, one per call — throws if exhausted, so a test that reads more calls
 * than it planned for fails loudly instead of hanging on `undefined.ok`. */
function scriptedAi(
  responses: ReadonlyArray<
    Parameters<AiPort["generateStructured"]>[0] extends never
      ? never
      : Awaited<ReturnType<AiPort["generateStructured"]>>
  >
): AiPort & { calls: Array<{ prompt: string }> } {
  const calls: Array<{ prompt: string }> = [];
  let index = 0;
  return {
    generateStructured: vi.fn(async (input) => {
      calls.push({ prompt: input.prompt });
      const response = responses[index];
      index++;
      if (response === undefined) {
        throw new Error("scriptedAi: ran out of scripted responses");
      }
      return response;
    }),
    calls
  };
}

function runDeps(overrides: {
  store: JobSearchStore;
  ai: AiPort;
  budget: number;
  notify?: NotifyPort;
  embed?: EmbedPort;
  deadlineAt?: number;
  clock?: () => number;
}) {
  return {
    store: overrides.store,
    embed: overrides.embed ?? createFakeEmbed(),
    ai: overrides.ai,
    notify: overrides.notify ?? createFakeNotify(),
    profileId: PROFILE_ID,
    budget: overrides.budget,
    now: NOW,
    deadlineAt: overrides.deadlineAt ?? Date.now() + 60_000,
    clock: overrides.clock ?? (() => Date.now())
  };
}

describe("runScore", () => {
  it("test 1: triage picks the batch — only selected postings are sent to the model", async () => {
    // Ten postings, budget 3: triage selects at most 3, so at most 3 generateStructured calls.
    const candidates = Array.from({ length: 10 }, (_, i) => makePosting(`p-${i}`));
    const store = createFakeStore({ profile: makeProfile(), candidates });
    const ai = scriptedAi(
      Array.from({ length: 3 }, () => ({ ok: true as const, object: okResult }))
    );

    const result = await runScore(runDeps({ store, ai, budget: 3 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(3);
    expect(result.scored).toBe(3);
  });

  it("test 1b: scoring asks the router for the cheap tier, not the expensive one (#1421)", async () => {
    const candidates = [makePosting("p-1")];
    const store = createFakeStore({ profile: makeProfile(), candidates });
    const ai = scriptedAi([{ ok: true, object: okResult }]);

    await runScore(runDeps({ store, ai, budget: 1 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    const call = (ai.generateStructured as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(call?.tierHint).toBe("economy");
  });

  it("test 2: outsideFrame from triage is persisted onto the match", async () => {
    // Rig one posting so it lands in the recall bucket: low criteria similarity, high profile
    // similarity, by giving it an orthogonal-then-aligned embedding relative to the two query
    // vectors the fake embed port returns (both [1,0,0]) — instead, directly control via a
    // second embed call. Simpler: since embedQuery always returns [1,0,0] here, cosine
    // similarity to every posting embedding [1,0,0] is 1 for both axes, which never triggers
    // outsideFrame. Use a custom embed port returning different vectors for criteria vs context.
    const posting = makePosting("p-outside");
    // The recall case NEEDS a context summary: it means "outside your stated criteria but
    // matching who you are", and the "who" is exactly this field. `makeProfile()`'s default is
    // null, which is why this must be set explicitly — see test 2b for what null now does.
    const store = createFakeStore({
      profile: makeProfile({ contextSummary: "Ten years in platform infrastructure." }),
      candidates: [posting]
    });
    const ai = scriptedAi([{ ok: true, object: okResult }]);
    let call = 0;
    const embed: EmbedPort = {
      embedDocuments: vi.fn(async () => {
        throw new Error("not used");
      }),
      // First call is the criteria vector (orthogonal to the posting -> low similarity),
      // second is the context vector (aligned with the posting -> high similarity).
      embedQuery: vi.fn(async () => {
        call++;
        return call === 1 ? [0, 1, 0] : [1, 0, 0];
      }),
      dimensions: vi.fn(async () => 3)
    };

    await runScore(runDeps({ store, ai, budget: 1, embed }));

    expect(store.__matches).toHaveLength(1);
    expect(store.__matches[0]?.outsideFrame).toBe(true);
  });

  it("test 2c: with no résumé on file the match stores fit null, not the model's placeholder 0", async () => {
    // The live-path regression this pair of tests exists for. Fit is judged against the résumé
    // and nothing else, so with none on file the prompt tells the model to answer 0 — but 0 is a
    // SCORE. Persisted, it lands in the board's Fit column drawn as a bar, sorts as the worst
    // possible match, and is indistinguishable from a 0 the model reasoned its way to, sitting
    // next to a Want it genuinely judged. Null is the difference between "terrible fit" and "no
    // basis to say". Want is unaffected: it is judged against the user's own words, which are
    // there either way.
    const store = createFakeStore({ profile: makeProfile(), candidates: [makePosting("p-1")] });
    const ai = scriptedAi([{ ok: true, object: { ...okResult, fit: 0 } }]);

    await runScore(runDeps({ store, ai, budget: 1 }));

    expect(store.__matches[0]?.fit).toBeNull();
    expect(store.__matches[0]?.want).toBe(70);
  });

  it("test 2d: with a résumé on file the model's fit is persisted verbatim", async () => {
    const store = createFakeStore({
      profile: makeProfile(),
      candidates: [makePosting("p-1")],
      resume: {
        id: "resume-1",
        version: 1,
        content: "Ten years building design systems.",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }
    });
    const ai = scriptedAi([{ ok: true, object: okResult }]);

    await runScore(runDeps({ store, ai, budget: 1 }));

    expect(store.__matches[0]?.fit).toBe(80);
  });

  it("guards every match write with the profile snapshot loaded by the stage", async () => {
    const criteria = makeCriteria({ mustHave: ["TypeScript"] });
    const store = createFakeStore({
      profile: makeProfile({ criteria }),
      candidates: [makePosting("p-criteria-snapshot")]
    });
    const ai = scriptedAi([{ ok: true, object: okResult }]);

    await runScore(runDeps({ store, ai, budget: 1 }));

    expect(store.upsertMatch).toHaveBeenCalledWith(
      PROFILE_ID,
      expect.objectContaining({ postingId: "p-criteria-snapshot" }),
      { criteriaSnapshot: criteria }
    );
  });

  it("keeps a CAS-rejected candidate deferred and does not announce it", async () => {
    const store = createFakeStore({
      profile: makeProfile(),
      candidates: [makePosting("p-stale-score")]
    });
    const notify = createFakeNotify();
    vi.mocked(store.upsertMatch).mockResolvedValue(false);

    const result = await runScore(
      runDeps({ store, ai: scriptedAi([{ ok: true, object: okResult }]), notify, budget: 1 })
    );

    expect(result).toEqual({
      scored: 0,
      deferred: 1,
      failed: 0,
      aiCallsUsed: 1,
      halted: null
    });
    expect(notify.post).not.toHaveBeenCalled();
  });

  it.each([
    ["insufficient_evidence", 99, 84],
    ["domain_mismatch", 99, 39],
    ["dealbreaker", 99, 39],
    ["domain_mismatch", 20, 20]
  ] as const)(
    "normalizes %s Fit %s to %s without changing Want or reasons",
    async (fitDisposition, fit, expectedFit) => {
      const store = createFakeStore({
        profile: makeProfile(),
        candidates: [makePosting("p-1")],
        resume: {
          id: "resume-1",
          version: 1,
          content: "Ten years building design systems.",
          updatedAt: "2026-07-28T00:00:00.000Z"
        }
      });
      const ai = scriptedAi([
        {
          ok: true,
          object: {
            ...okResult,
            fit,
            fitDisposition,
            want: 73,
            fitReason: "Specific Fit evidence.",
            wantReason: "Specific Want evidence."
          }
        }
      ]);

      await runScore(runDeps({ store, ai, budget: 1 }));

      expect(store.__matches[0]).toMatchObject({
        fit: expectedFit,
        want: 73,
        fitReason: "Specific Fit evidence.",
        wantReason: "Specific Want evidence."
      });
    }
  );

  it("rescores an invalidated row through the existing unfitted pass", async () => {
    const posting = makePosting("p-invalidated");
    const criteria = makeCriteria();
    const store = createFakeStore({
      profile: makeProfile({ criteria }),
      candidates: [],
      unfittedCandidates: [posting],
      resume: {
        id: "resume-1",
        version: 1,
        content: "Ten years building design systems.",
        updatedAt: "2026-07-28T00:00:00.000Z"
      }
    });
    const ai = scriptedAi([{ ok: true, object: okResult }]);

    const result = await runScore({
      ...runDeps({ store, ai, budget: 1 }),
      candidates: "unfitted"
    });

    expect(result.scored).toBe(1);
    expect(store.listUnfittedPostingsWithEmbeddings).toHaveBeenCalled();
    expect(store.__matches[0]?.postingId).toBe("p-invalidated");
    expect(store.__matches[0]?.fit).toBe(80);
    expect(store.upsertMatch).toHaveBeenCalledWith(
      "profile-1",
      expect.objectContaining({ postingId: "p-invalidated" }),
      { preserveWant: true, criteriaSnapshot: criteria }
    );
  });

  it("keeps an invalidated row unscored when the profile still has no résumé", async () => {
    const store = createFakeStore({
      profile: makeProfile(),
      candidates: [],
      unfittedCandidates: [makePosting("p-no-resume")]
    });
    const ai = scriptedAi([{ ok: true, object: { ...okResult, fit: 99 } }]);

    await runScore({
      ...runDeps({ store, ai, budget: 1 }),
      candidates: "unfitted"
    });

    expect(store.__matches[0]?.fit).toBeNull();
    expect(store.__matches[0]?.want).toBe(70);
  });

  it("test 2b: a profile with no context summary is embedded once and yields no recall-bucket match (#1306)", async () => {
    // The live-path regression. `context_summary` is written only by the `profile.set-context`
    // tool during the onboarding conversation, but `isReadyToCrawl` never asks for it — so any
    // user who sets criteria and leaves has a crawlable profile with a null summary. Passing
    // that through as "" made the host reject the RPC (`invalid_rpc`, empty string), which took
    // down the entire crawl invocation as an opaque `handler_failed`.
    //
    // The stub embed port is why no existing test caught it: it answers "" as happily as any
    // other string. So this test pins the CALL COUNT, not the vectors — the contract is that
    // an absent context is never embedded at all.
    const posting = makePosting("p-nocontext");
    const store = createFakeStore({
      profile: makeProfile({ contextSummary: null }),
      candidates: [posting]
    });
    const ai = scriptedAi([{ ok: true, object: okResult }]);
    const embed: EmbedPort = {
      embedDocuments: vi.fn(async () => {
        throw new Error("not used");
      }),
      // Orthogonal to the posting's embedding. If the context vector were still being computed
      // from this port it would be identical to the criteria vector, so the posting would score
      // low on BOTH axes — the assertion below would pass for the wrong reason. Instead the
      // call-count assertion is what carries the contract.
      embedQuery: vi.fn(async () => [0, 1, 0]),
      dimensions: vi.fn(async () => 3)
    };

    await runScore(runDeps({ store, ai, budget: 1, embed }));

    expect(embed.embedQuery).toHaveBeenCalledTimes(1);
    expect(store.__matches).toHaveLength(1);
    // Profile similarity is 0 for every candidate, so nothing can clear the recall bucket's
    // OUTSIDE_FRAME_PROFILE_MIN floor. Triage ranks on criteria alone — the honest degradation.
    expect(store.__matches[0]?.outsideFrame).toBe(false);
  });

  it("test 3: an {ok: true} envelope whose object fails parseScoreResult leaves the posting unscored and increments failed", async () => {
    const posting = makePosting("p-badparse");
    const store = createFakeStore({ profile: makeProfile(), candidates: [posting] });
    const ai = scriptedAi([
      { ok: true, object: { fit: 200, want: 70, fitReason: "x", wantReason: "y" } }
    ]);

    const result = await runScore(runDeps({ store, ai, budget: 1 }));

    expect(result.failed).toBe(1);
    expect(result.scored).toBe(0);
    expect(store.__matches).toHaveLength(0);
  });

  it("test 4: one bad result does not abort the batch — the other postings still score", async () => {
    const postings = [makePosting("p-bad"), makePosting("p-good")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([
      { ok: true, object: { fit: 200, want: 70, fitReason: "x", wantReason: "y" } },
      { ok: true, object: okResult }
    ]);

    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(result.failed).toBe(1);
    expect(result.scored).toBe(1);
  });

  it("test 5: needs_config halts immediately and scores nothing further; exactly one generateStructured call", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2"), makePosting("p-3")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([{ ok: false, error: "needs_config" }]);

    const result = await runScore(runDeps({ store, ai, budget: 3 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(0);
    expect(result.halted?.reason).toBe("needs_config");
  });

  it("test 6: usage_limited halts and leaves the rest unscored, not failed", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([{ ok: false, error: "usage_limited" }]);

    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(result.failed).toBe(0);
    expect(result.halted?.reason).toBe("usage_limited");
    // Neither posting was written as a match — both remain "unscored" by omission.
    expect(store.__matches).toHaveLength(0);
  });

  it("test 7: aborted ends the stage — exactly one call, zero failed", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([{ ok: false, error: "aborted" }]);

    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.failed).toBe(0);
    expect(result.halted?.reason).toBe("aborted");
  });

  it("test 8: provider_error gets exactly one retry across the whole stage, on the same posting", async () => {
    const posting = makePosting("p-retry");
    const store = createFakeStore({ profile: makeProfile(), candidates: [posting] });
    const ai = scriptedAi([
      { ok: false, error: "provider_error" },
      { ok: true, object: okResult }
    ]);

    // Budget 2, not 1: the retry only fires when a call remains in the budget after the first
    // failure (`aiCallsUsed < scoreBudget`) — at budget 1 the stage has no room for a retry at
    // all and halts usage_limited instead (see test 13).
    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(2);
    // Both calls carried the same posting id in their prompt — the retry never silently
    // dropped the posting it claimed to retry for the next one.
    expect(ai.calls[0]?.prompt).toContain("p-retry");
    expect(ai.calls[1]?.prompt).toContain("p-retry");
    expect(result.scored).toBe(1);
    expect(result.halted).toBeNull();
  });

  it("test 8b: a second provider_error anywhere in the stage halts", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([
      { ok: false, error: "provider_error" },
      { ok: true, object: okResult },
      { ok: false, error: "provider_error" }
    ]);

    // Budget 3: posting 1 costs two calls (fail + retry), leaving exactly one call for posting
    // 2 — enough for it to be reached and hit the stage's second, unretried provider_error.
    const result = await runScore(runDeps({ store, ai, budget: 3 }));

    expect(result.halted?.reason).toBe("provider_error");
  });

  it("test 9: validation_failed is per-posting — increments failed, leaves unscored, keeps going", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([
      { ok: false, error: "validation_failed" },
      { ok: true, object: okResult }
    ]);

    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(result.failed).toBe(1);
    expect(result.scored).toBe(1);
    expect(result.halted).toBeNull();
  });

  it("test 10: never more than budget calls, never more than AI_CALL_BUDGET — 40 candidates, budget 8 -> exactly 8 calls, remainder deferred", async () => {
    const postings = Array.from({ length: 40 }, (_, i) => makePosting(`p-${i}`));
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi(
      Array.from({ length: 8 }, () => ({ ok: true as const, object: okResult }))
    );

    const result = await runScore(runDeps({ store, ai, budget: 8 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(8);
    expect(result.scored).toBe(8);
    expect(result.deferred).toBe(32);
  });

  it("test 11: budget 0 makes no calls at all and returns aiCallsUsed 0 without an error", async () => {
    const postings = [makePosting("p-1")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([]);

    const result = await runScore(runDeps({ store, ai, budget: 0 }));

    expect(ai.generateStructured).not.toHaveBeenCalled();
    expect(result.aiCallsUsed).toBe(0);
    expect(result.halted).toBeNull();
  });

  it("test 12: aiCallsUsed equals the number of generateStructured calls, including failures — a retry counts", async () => {
    const posting = makePosting("p-1");
    const store = createFakeStore({ profile: makeProfile(), candidates: [posting] });
    const ai = scriptedAi([
      { ok: false, error: "provider_error" },
      { ok: true, object: okResult }
    ]);

    // Budget 2 for the same reason as test 8 — a retry needs a spare call in the budget.
    const result = await runScore(runDeps({ store, ai, budget: 2 }));

    expect(result.aiCallsUsed).toBe(2);
  });

  it("test 13: a retry cannot exceed budget — budget 1, one candidate, first call provider_error -> exactly one call and a usage_limited halt", async () => {
    const posting = makePosting("p-1");
    const store = createFakeStore({ profile: makeProfile(), candidates: [posting] });
    const ai = scriptedAi([{ ok: false, error: "provider_error" }]);

    const result = await runScore(runDeps({ store, ai, budget: 1 }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.halted?.reason).toBe("usage_limited");
  });

  it("test 14: a retry cannot exceed AI_CALL_BUDGET either — budget-many candidates, first returns provider_error -> exactly AI_CALL_BUDGET calls total", async () => {
    // Sized off the constant, not a literal: the budget is a product decision that moves, and
    // a fixture pinned to the old value of 8 would stop exhausting the budget the moment it
    // did — the retry would then have spare calls to spend and the invariant under test here
    // would go unexercised while the test still passed.
    const postings = Array.from({ length: AI_CALL_BUDGET }, (_, i) => makePosting(`p-${i}`));
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const responses: Array<Awaited<ReturnType<AiPort["generateStructured"]>>> = [
      { ok: false, error: "provider_error" },
      ...Array.from({ length: AI_CALL_BUDGET - 1 }, () => ({
        ok: true as const,
        object: okResult
      }))
    ];
    const ai = scriptedAi(responses);

    const result = await runScore(runDeps({ store, ai, budget: AI_CALL_BUDGET }));

    expect(ai.generateStructured).toHaveBeenCalledTimes(AI_CALL_BUDGET);
    // The retry consumed the last posting's call, so that posting is deferred.
    expect(result.deferred).toBe(1);
  });

  it("test 15: a notification fires once per pass with the new-match count, not once per match", async () => {
    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([
      { ok: true, object: okResult },
      { ok: true, object: okResult }
    ]);
    const notify = createFakeNotify();

    await runScore(runDeps({ store, ai, budget: 2, notify }));

    expect(notify.post).toHaveBeenCalledTimes(1);
    expect(notify.__posted[0]?.body).toContain("2");
  });

  it("test 16: the notification body never contains a blended number", async () => {
    const postings = [makePosting("p-1")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([{ ok: true, object: okResult }]);
    const notify = createFakeNotify();

    await runScore(runDeps({ store, ai, budget: 1, notify }));

    expect(notify.__posted[0]?.body).not.toMatch(/\b(overall|combined|score of)\b/i);
  });

  it("test 17: a pass that scores nothing posts no notification; a pass that scores 2 says 2, not a store-wide count", async () => {
    const zeroStore = createFakeStore({ profile: makeProfile(), candidates: [] });
    const zeroAi = scriptedAi([]);
    const zeroNotify = createFakeNotify();
    await runScore(runDeps({ store: zeroStore, ai: zeroAi, budget: 8, notify: zeroNotify }));
    expect(zeroNotify.post).not.toHaveBeenCalled();

    const postings = [makePosting("p-1"), makePosting("p-2")];
    const store = createFakeStore({ profile: makeProfile(), candidates: postings });
    const ai = scriptedAi([
      { ok: true, object: okResult },
      { ok: true, object: okResult }
    ]);
    const notify = createFakeNotify();
    await runScore(runDeps({ store, ai, budget: 2, notify }));

    expect(notify.__posted[0]?.body).toContain("2");
    expect(notify.__posted[0]?.body).not.toMatch(/30/);
  });

  it("test 18: a call that cannot finish before the deadline is never started — the loop winds down instead of overrunning", async () => {
    // `deadlineAt` is the instant the host KILLS the invocation, not a soft budget: a call still in
    // flight when it lands dies with the whole handler, taking the partial result with it. So the
    // question this loop has to answer between postings is "is there time to FINISH a call", not
    // "is there time left at all" — and the only honest estimate of a call's cost is how long the
    // calls in THIS run have actually taken.
    //
    // The clock is driven by the model port itself: call 1 consumes half the window. A bare
    // `clock() >= deadlineAt` check passes happily at that point and starts a second call that
    // cannot possibly return in time — which is exactly the live failure this guards (a crawl
    // killed at the 600s ceiling, reporting a failure instead of the 73 rows it had scored).
    const start = 1_000_000;
    let nowMs = start;
    const windowMs = 200_000;

    const store = createFakeStore({
      profile: makeProfile(),
      candidates: [makePosting("p-1"), makePosting("p-2"), makePosting("p-3")]
    });
    const ai: AiPort = {
      generateStructured: vi.fn(async () => {
        nowMs += windowMs / 2;
        return { ok: true as const, object: okResult };
      })
    };

    const result = await runScore(
      runDeps({
        store,
        ai,
        budget: 8,
        deadlineAt: start + windowMs,
        clock: () => nowMs
      })
    );

    // One call, then a graceful stop with time still on the clock — not three calls and a kill.
    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(1);
    expect(result.halted?.reason).toBe("deadline");
    expect(nowMs).toBeLessThan(start + windowMs);
    // The two it never reached are reported as deferred, so the caller can say "more next time".
    expect(result.deferred).toBe(2);
  });

  it("test 19: the unmeasured reserve floor never swallows the whole window — a short invocation still scores", async () => {
    // The floor is a guess about a call that has not happened yet, and a guess must never be big
    // enough to consume the window it is protecting. Handed a window far shorter than the floor,
    // a flat reserve would refuse to start anything and score nothing at all — a conservative
    // guard turned into a total one. Capping only the UNMEASURED floor keeps that from happening
    // while leaving a real measured duration free to reserve as much as it truly needs.
    const start = 1_000_000;
    let nowMs = start;

    const store = createFakeStore({ profile: makeProfile(), candidates: [makePosting("p-1")] });
    const ai: AiPort = {
      generateStructured: vi.fn(async () => {
        nowMs += 10;
        return { ok: true as const, object: okResult };
      })
    };

    const result = await runScore(
      runDeps({ store, ai, budget: 8, deadlineAt: start + 300, clock: () => nowMs })
    );

    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.scored).toBe(1);
    expect(result.halted).toBeNull();
  });
});
