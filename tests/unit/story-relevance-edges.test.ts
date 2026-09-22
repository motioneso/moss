import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "../../packages/db/src/index.js";
import {
  MAX_STORY_RELEVANCE_VERDICTS,
  STORY_RELEVANCE_RULE_VERSION,
  storyRelevanceResponseSchema,
  type StoryRelevanceCandidate,
  type StoryRelevanceFailure
} from "../../packages/shared/src/index.js";
import {
  compileStoryRelevanceRule,
  storyRelevanceDirectionForKind,
  storyRelevanceRuleNeedsRecompile
} from "../../packages/usefulness-feedback/src/relevance/compile.js";
import {
  evaluateStoryRelevance,
  type StoryRelevanceAiPort
} from "../../packages/usefulness-feedback/src/relevance/evaluator.js";
import {
  createStoryRelevancePolicy,
  type StoryRelevanceLogger
} from "../../packages/usefulness-feedback/src/relevance/policy.js";
import type { ActiveStoryRuleRow } from "../../packages/usefulness-feedback/src/repository.js";

/**
 * Edge coverage for the story relevance pipeline: every feedback kind maps to a
 * direction or to nothing, compiling survives hostile input, the evaluator splits
 * large batches and refuses bad answers wholesale, and the policy degrades
 * honestly. Empty input, ties and boundary lengths are covered throughout.
 */

const SCOPED_DB = {} as DataContextDb;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const OWNER = "33333333-3333-4333-8333-333333333333";

function ruleRow(overrides: Partial<ActiveStoryRuleRow> = {}): ActiveStoryRuleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    targetRef: "story:rule-1",
    direction: "less",
    reasonText: "Too much of this",
    rule: {
      version: STORY_RELEVANCE_RULE_VERSION,
      module: "news",
      direction: "less",
      storyRef: "story:rule-1",
      terms: ["gossip"]
    },
    ...overrides
  };
}

function candidate(
  ref: string,
  overrides: Partial<StoryRelevanceCandidate> = {}
): StoryRelevanceCandidate {
  return {
    storyRef: ref,
    headline: `Headline for ${ref}`,
    sourceLabel: "Example Daily",
    publishedAt: "2026-08-20T12:00:00.000Z",
    feedPosition: 0,
    ...overrides
  };
}

function silentLogger(): { logger: StoryRelevanceLogger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  return {
    lines,
    logger: {
      info: (fields) => lines.push(fields),
      warn: (fields) => lines.push(fields)
    }
  };
}

describe("which feedback kinds become story preferences", () => {
  it("points less_like_this at less and more_like_this at more", () => {
    expect(storyRelevanceDirectionForKind("less_like_this")).toBe("less");
    expect(storyRelevanceDirectionForKind("more_like_this")).toBe("more");
  });

  it("leaves every other kind out of story relevance entirely", () => {
    for (const kind of [
      "too_much",
      "wrong_priority",
      "not_useful",
      "remember_this",
      "dismiss"
    ] as const) {
      expect(storyRelevanceDirectionForKind(kind)).toBeNull();
    }
  });
});

describe("compiling a preference with hostile input", () => {
  it("ignores context values that are not usable identifiers", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "less",
      storyRef: "story:edge-1",
      context: {
        teamRef: 42,
        competitionRef: null,
        topicRef: { nested: true }
      } as unknown as Record<string, unknown>,
      reasonText: "Riverside derby"
    });
    expect(rule.terms).toContain("riverside");
    expect(rule.terms).not.toContain("42");
    expect(rule.terms).not.toContain("[object object]");
  });

  it("keeps a two-letter term and drops one-letter and over-long terms", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:edge-2",
      context: {},
      reasonText: `a go ${"x".repeat(40)} ${"y".repeat(41)}`
    });
    expect(rule.terms).toContain("go");
    expect(rule.terms).toContain("x".repeat(40));
    expect(rule.terms).not.toContain("a");
    expect(rule.terms).not.toContain("y".repeat(41));
  });

  it("de-duplicates a word the reason repeats", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:edge-3",
      context: {},
      reasonText: "cricket cricket CRICKET cricket"
    });
    expect(rule.terms.filter((term) => term === "cricket")).toHaveLength(1);
  });

  it("keeps the stable identifiers first when the reason is long", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "less",
      storyRef: "story:edge-4",
      context: { teamRef: "team:riverside", competitionRef: "competition:premier" },
      reasonText: Array.from({ length: 30 }, (_, i) => `subject${i}`).join(" ")
    });
    expect(rule.terms.slice(0, 2)).toEqual(["team:riverside", "competition:premier"]);
    expect(rule.terms.length).toBeLessThanOrEqual(8);
  });

  it("compiles a filler-only reason down to the stable identifiers", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "less",
      storyRef: "story:edge-5",
      context: { teamRef: "team:riverside", competitionRef: "competition:premier" },
      reasonText: "the and of this with that"
    });
    expect(rule.terms).toEqual(["team:riverside", "competition:premier"]);
  });

  it("compiles empty context and no reason to an empty rule", () => {
    for (const reasonText of [undefined, null, ""]) {
      const rule = compileStoryRelevanceRule({
        moduleId: "news",
        direction: "less",
        storyRef: "story:edge-6",
        context: {},
        reasonText: reasonText as null
      });
      expect(rule.terms).toEqual([]);
      expect(rule.storyRef).toBe("story:edge-6");
    }
  });

  it("rebuilds rules with a missing, older or malformed version", () => {
    const good = {
      version: STORY_RELEVANCE_RULE_VERSION,
      module: "news",
      direction: "less",
      storyRef: "story:one",
      terms: ["gossip"]
    };
    expect(storyRelevanceRuleNeedsRecompile(good, STORY_RELEVANCE_RULE_VERSION)).toBe(false);
    expect(storyRelevanceRuleNeedsRecompile(good, null)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile({ ...good, version: 0 }, 0)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile({ ...good, terms: "gossip" }, 1)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile([], 1)).toBe(true);
  });
});

describe("evaluator empty input and batching", () => {
  function echoPort(calls: string[][]): StoryRelevanceAiPort {
    return {
      async generateJson(_scopedDb, input) {
        const [, tail] = input.prompt.split("candidate stories:\n");
        const rows = JSON.parse(tail ?? "[]") as { storyRef: string }[];
        calls.push(rows.map((row) => row.storyRef));
        return {
          ok: true,
          object: {
            verdicts: rows.map((row) => ({
              storyRef: row.storyRef,
              matched: false,
              ruleStoryRef: null,
              eventEvidence: [],
              editorialEvidence: []
            }))
          }
        };
      }
    };
  }

  it("makes no call and returns no verdicts when there are no candidates", async () => {
    const generateJson = vi.fn(async () => ({ ok: true as const, object: { verdicts: [] } }));
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: { generateJson } },
      { candidates: [], rules: [ruleRow()] }
    );
    expect(generateJson).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, verdicts: [] });
  });

  it("makes no call when both lists are empty", async () => {
    const generateJson = vi.fn(async () => ({ ok: true as const, object: { verdicts: [] } }));
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: { generateJson } },
      { candidates: [], rules: [] }
    );
    expect(generateJson).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true, verdicts: [] });
  });

  it("splits a long list into successive calls and joins the verdicts", async () => {
    const calls: string[][] = [];
    const candidates = Array.from({ length: 150 }, (_, i) =>
      candidate(`story:bulk-${i}`, {
        headline: `Bulk headline number ${i} with enough padding to fill the budget ${"p".repeat(100)}`,
        feedPosition: i
      })
    );
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: echoPort(calls) },
      { candidates, rules: [ruleRow()] }
    );
    expect(calls.length).toBeGreaterThan(1);
    for (const chunk of calls) {
      expect(chunk.length).toBeLessThanOrEqual(MAX_STORY_RELEVANCE_VERDICTS);
    }
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected verdicts");
    expect(result.verdicts).toHaveLength(candidates.length);
    expect(new Set(result.verdicts.map((v) => v.storyRef)).size).toBe(candidates.length);
  });

  it("fails the whole evaluation when a later chunk is malformed", async () => {
    let calls = 0;
    const candidates = Array.from({ length: 150 }, (_, i) =>
      candidate(`story:chunk-${i}`, {
        headline: `Chunk headline ${i} ${"q".repeat(100)}`,
        feedPosition: i
      })
    );
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      {
        ai: {
          async generateJson(_scopedDb, input) {
            calls += 1;
            if (calls === 1) {
              const [, tail] = input.prompt.split("candidate stories:\n");
              const rows = JSON.parse(tail ?? "[]") as { storyRef: string }[];
              return {
                ok: true,
                object: {
                  verdicts: rows.map((row) => ({
                    storyRef: row.storyRef,
                    matched: false,
                    ruleStoryRef: null,
                    eventEvidence: [],
                    editorialEvidence: []
                  }))
                }
              };
            }
            return { ok: true, object: { verdicts: [{ bogus: true }] } };
          }
        }
      },
      { candidates, rules: [ruleRow()] }
    );
    expect(calls).toBeGreaterThan(1);
    expect(result).toEqual({ ok: false, error: "malformed_output" });
  });

  it("refuses an answer that repeats the same story twice", async () => {
    const only = candidate("story:solo");
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      {
        ai: {
          async generateJson() {
            const verdict = {
              storyRef: "story:solo",
              matched: false,
              ruleStoryRef: null,
              eventEvidence: [],
              editorialEvidence: []
            };
            return { ok: true, object: { verdicts: [verdict, verdict] } };
          }
        }
      },
      { candidates: [only], rules: [ruleRow()] }
    );
    expect(result).toEqual({ ok: false, error: "malformed_output" });
  });

  it("sends only the allowed story fields and holds the fixed answer shape", async () => {
    const prompts: string[] = [];
    const schemas: unknown[] = [];
    const withBody = {
      ...candidate("story:fields"),
      headline: "A headline",
      ...({ body: "Full article text that must never travel" } as Record<string, unknown>)
    } as StoryRelevanceCandidate;
    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      {
        ai: {
          async generateJson(_scopedDb, input) {
            prompts.push(input.prompt);
            schemas.push(input.schema);
            return {
              ok: true,
              object: {
                verdicts: [
                  {
                    storyRef: "story:fields",
                    matched: false,
                    ruleStoryRef: null,
                    eventEvidence: [],
                    editorialEvidence: []
                  }
                ]
              }
            };
          }
        }
      },
      { candidates: [withBody], rules: [ruleRow()] }
    );
    expect(result.ok).toBe(true);
    expect(schemas[0]).toEqual(storyRelevanceResponseSchema);
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("story:fields");
    expect(prompt).not.toContain("Full article text");
    expect(prompt).not.toContain('"body"');
  });
});

describe("policy empty input, degradation and ties", () => {
  function matchedPort(): StoryRelevanceAiPort {
    return {
      async generateJson(_scopedDb, input) {
        const [, tail] = input.prompt.split("candidate stories:\n");
        const rows = JSON.parse(tail ?? "[]") as { storyRef: string }[];
        return {
          ok: true,
          object: {
            verdicts: rows.map((row) => ({
              storyRef: row.storyRef,
              matched: true,
              ruleStoryRef: "story:rule-1",
              eventEvidence: [],
              editorialEvidence: []
            }))
          }
        };
      }
    };
  }

  function moreRule(): ActiveStoryRuleRow {
    return ruleRow({
      direction: "more",
      reasonText: null,
      rule: {
        version: STORY_RELEVANCE_RULE_VERSION,
        module: "news",
        direction: "more",
        storyRef: "story:rule-1",
        terms: ["gossip"]
      }
    });
  }

  it("keeps an empty list empty without calling the model", async () => {
    const generateJson = vi.fn(async () => ({ ok: true as const, object: { verdicts: [] } }));
    const policy = createStoryRelevancePolicy({
      ai: { generateJson },
      repository: { listActiveStoryRules: async () => [ruleRow()] },
      logger: silentLogger().logger
    });
    const result = await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: [],
      now: NOW
    });
    expect(generateJson).not.toHaveBeenCalled();
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    expect(result.kept).toEqual([]);
    expect(result.suppressedCount).toBe(0);
  });

  it("degrades on every failure but still honours the owner's dismissal", async () => {
    const failures: StoryRelevanceFailure[] = [
      "needs_config",
      "validation_failed",
      "provider_error",
      "aborted",
      "malformed_output"
    ];
    for (const failure of failures) {
      const { logger, lines } = silentLogger();
      const policy = createStoryRelevancePolicy({
        ai: { generateJson: async () => ({ ok: false as const, error: failure }) },
        repository: { listActiveStoryRules: async () => [ruleRow()] },
        logger
      });
      const kept = candidate("story:kept");
      const dismissed = candidate("story:rule-1");
      const result = await policy(SCOPED_DB, {
        ownerUserId: OWNER,
        moduleId: "news",
        candidates: [dismissed, kept],
        now: NOW
      });
      expect(result.status).toBe("degraded");
      if (result.status !== "degraded") throw new Error("expected degraded");
      expect(result.failure).toBe(failure);
      expect(result.excludedRefs).toEqual(["story:rule-1"]);
      expect(result.kept.map((c) => c.storyRef)).toEqual(["story:kept"]);
      expect(lines.map((l) => l.event)).toContain("story_relevance_degraded");
    }
  });

  it("logs a degraded run without leaking story content", async () => {
    const { logger, lines } = silentLogger();
    const policy = createStoryRelevancePolicy({
      ai: { generateJson: async () => ({ ok: false as const, error: "provider_error" }) },
      repository: { listActiveStoryRules: async () => [ruleRow()] },
      logger
    });
    await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: [candidate("story:rule-1", { headline: "Secret headline" })],
      now: NOW
    });
    const logged = JSON.stringify(lines);
    expect(logged).not.toContain("Secret headline");
    expect(logged).not.toContain("story:rule-1");
    expect(logged).toContain("provider_error");
  });

  it("breaks an age tie by feed position, newest among equals first", async () => {
    const { logger } = silentLogger();
    const policy = createStoryRelevancePolicy({
      ai: matchedPort(),
      repository: { listActiveStoryRules: async () => [moreRule()] },
      logger
    });
    const sameHour = "2026-08-20T12:00:00.000Z";
    const result = await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: [
        candidate("story:tie-last", { publishedAt: sameHour, feedPosition: 2 }),
        candidate("story:tie-first", { publishedAt: sameHour, feedPosition: 0 }),
        candidate("story:tie-middle", { publishedAt: sameHour, feedPosition: 1 })
      ],
      now: NOW
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    expect(result.kept).toHaveLength(3);
    expect(result.boosts.map((b) => b.storyRef)).toEqual(["story:tie-first", "story:tie-middle"]);
  });

  it("lifts only the two newest stories for one preference", async () => {
    const { logger } = silentLogger();
    const policy = createStoryRelevancePolicy({
      ai: matchedPort(),
      repository: { listActiveStoryRules: async () => [moreRule()] },
      logger
    });
    const result = await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: [
        candidate("story:oldest", { publishedAt: "2026-08-17T12:00:00.000Z", feedPosition: 0 }),
        candidate("story:mid", { publishedAt: "2026-08-19T12:00:00.000Z", feedPosition: 1 }),
        candidate("story:new", { publishedAt: "2026-08-20T12:00:00.000Z", feedPosition: 2 }),
        candidate("story:newest", { publishedAt: "2026-08-21T12:00:00.000Z", feedPosition: 3 })
      ],
      now: NOW
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    expect(result.kept).toHaveLength(4);
    expect(result.boosts.map((b) => b.storyRef)).toEqual(["story:newest", "story:new"]);
    for (const boost of result.boosts) expect(boost.lift).toBe(1);
  });

  it("lifts nothing when no verdict matches the preference", async () => {
    const { logger } = silentLogger();
    const policy = createStoryRelevancePolicy({
      ai: {
        async generateJson() {
          return {
            ok: true,
            object: {
              verdicts: [
                {
                  storyRef: "story:plain",
                  matched: false,
                  ruleStoryRef: null,
                  eventEvidence: [],
                  editorialEvidence: []
                }
              ]
            }
          };
        }
      },
      repository: { listActiveStoryRules: async () => [moreRule()] },
      logger
    });
    const result = await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: [candidate("story:plain")],
      now: NOW
    });
    expect(result.status).toBe("applied");
    if (result.status !== "applied") throw new Error("expected applied");
    expect(result.kept.map((c) => c.storyRef)).toEqual(["story:plain"]);
    expect(result.boosts).toEqual([]);
  });
});
