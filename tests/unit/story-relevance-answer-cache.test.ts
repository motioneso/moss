import { describe, expect, it } from "vitest";

import type { DataContextDb } from "../../packages/db/src/index.js";
import {
  STORY_RELEVANCE_RULE_VERSION,
  type StoryRelevanceCandidate
} from "../../packages/shared/src/index.js";
import {
  storyRelevanceAnswerKeyId,
  storyRelevanceRuleTextHash,
  type StoryRelevanceAnswerCachePort,
  type StoryRelevanceAnswerKey,
  type StoryRelevanceAskedAnswer,
  type StoryRelevanceStoredAnswer
} from "../../packages/usefulness-feedback/src/relevance/answer-cache.js";
import {
  evaluateStoryRelevance,
  type StoryRelevanceAiPort,
  type StoryRelevanceSortingBatch
} from "../../packages/usefulness-feedback/src/relevance/evaluator.js";
import {
  createStoryRelevancePolicy,
  type StoryRelevanceLogger
} from "../../packages/usefulness-feedback/src/relevance/policy.js";
import type { ActiveStoryRuleRow } from "../../packages/usefulness-feedback/src/repository.js";
import {
  REJECTED_STORY,
  STORY_RELEVANCE_FIXTURE,
  newsCandidate
} from "../fixtures/story-relevance.js";

/**
 * #2636: the remembered-answer cache at the evaluator boundary. These tests pin the four ways an
 * answer is reused or re-asked: a fresh hit, a miss, a mixed batch, and the three invalidations
 * (rule edited, model switched, answer expired). Nothing here reaches a database.
 */

const NOW = new Date("2026-09-24T12:00:00.000Z");
const SCOPED_DB = {} as DataContextDb;
const OWNER = "22222222-2222-4222-8222-222222222222";
const FINGERPRINT = "a".repeat(64);
const OLD_FINGERPRINT = "b".repeat(64);

function activeRule(reasonText = "Stop showing me transfer gossip"): ActiveStoryRuleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    targetRef: "story:rejected",
    direction: "less",
    reasonText,
    rule: {
      version: STORY_RELEVANCE_RULE_VERSION,
      module: "news",
      direction: "less",
      storyRef: "story:rejected",
      terms: ["topic:transfer-gossip"]
    }
  };
}

function twoStories(): StoryRelevanceCandidate[] {
  return [
    { ...newsCandidate(REJECTED_STORY), storyRef: "story:a" },
    { ...newsCandidate(STORY_RELEVANCE_FIXTURE[1]!), storyRef: "story:b" }
  ];
}

function keyFor(
  storyRef: string,
  row: ActiveStoryRuleRow,
  override: Partial<StoryRelevanceAnswerKey> = {}
): StoryRelevanceAnswerKey {
  return {
    storyRef,
    ruleId: row.id,
    ruleTextHash: storyRelevanceRuleTextHash(row.rule, row.reasonText),
    modelFingerprint: FINGERPRINT,
    ...override
  };
}

function storedAnswer(
  key: StoryRelevanceAnswerKey,
  answer: "yes" | "no",
  expiresAt: Date
): StoryRelevanceStoredAnswer {
  return { ...key, answer, confidence: answer === "yes" ? 0.9 : 0.1, expiresAt };
}

interface FakeCache {
  readonly port: StoryRelevanceAnswerCachePort;
  readonly reads: StoryRelevanceAnswerKey[][];
  readonly writes: (StoryRelevanceAnswerKey & StoryRelevanceAskedAnswer)[][];
}

function fakeCache(initial: readonly StoryRelevanceStoredAnswer[] = []): FakeCache {
  const stored = new Map(initial.map((row) => [storyRelevanceAnswerKeyId(row), row]));
  const reads: StoryRelevanceAnswerKey[][] = [];
  const writes: (StoryRelevanceAnswerKey & StoryRelevanceAskedAnswer)[][] = [];
  return {
    reads,
    writes,
    port: {
      async readStoryRelevanceAnswers(_db, _owner, keys) {
        reads.push([...keys]);
        return keys
          .map((key) => stored.get(storyRelevanceAnswerKeyId(key)))
          .filter((row): row is StoryRelevanceStoredAnswer => row !== undefined);
      },
      async writeStoryRelevanceAnswers(_db, _owner, answers) {
        writes.push([...answers]);
      }
    }
  };
}

interface FakeSorting {
  readonly port: StoryRelevanceAiPort;
  readonly calls: () => number;
  readonly questionIds: () => string[];
}

function sortingPort(
  decide: (questionId: string) => { choice: string; confidence: number },
  fingerprint: string | null = FINGERPRINT
): FakeSorting {
  let calls = 0;
  const batches: StoryRelevanceSortingBatch[][] = [];
  return {
    calls: () => calls,
    questionIds: () => batches.flat().flatMap((batch) => Object.keys(batch.questions)),
    port: {
      async generateJson() {
        return { ok: false as const, error: "provider_error" as const };
      },
      async sortingModelFingerprint() {
        return fingerprint;
      },
      async askSortingQuestions(_db, input) {
        calls += 1;
        batches.push([...input.batches]);
        const answers: Record<string, { choice: string; confidence: number }> = {};
        for (const batch of input.batches) {
          for (const id of Object.keys(batch.questions)) answers[id] = decide(id);
        }
        return { ok: true as const, answers, usage: { inputTokens: 1, outputTokens: 1 } };
      }
    }
  };
}

const FUTURE = new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000);

describe("remembered sorting answers (#2636)", () => {
  it("asks once and remembers the answers on a miss", async () => {
    const cache = fakeCache();
    const sorting = sortingPort(() => ({ choice: "yes", confidence: 0.9 }));

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      { candidates: twoStories(), rules: [activeRule()], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.calls()).toBe(1);
    expect(cache.writes.flat()).toHaveLength(2);
    expect(result.cache).toEqual({ remembered: 0, asked: 2 });
  });

  it("makes no request at all when every answer is remembered", async () => {
    const row = activeRule();
    const cache = fakeCache([
      storedAnswer(keyFor("story:a", row), "yes", FUTURE),
      storedAnswer(keyFor("story:b", row), "no", FUTURE)
    ]);
    const sorting = sortingPort(() => {
      throw new Error("the model must not be asked when every answer is remembered");
    });

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      { candidates: twoStories(), rules: [row], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.calls()).toBe(0);
    expect(cache.writes.flat()).toHaveLength(0);
    expect(result.cache).toEqual({ remembered: 2, asked: 0 });
    expect(result.verdicts[0]).toMatchObject({ storyRef: "story:a", matched: true });
    expect(result.verdicts[1]).toMatchObject({ storyRef: "story:b", matched: false });
  });

  it("asks only the misses in a mixed batch", async () => {
    const row = activeRule();
    const cache = fakeCache([storedAnswer(keyFor("story:a", row), "yes", FUTURE)]);
    const sorting = sortingPort(() => ({ choice: "no", confidence: 0.5 }));

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      { candidates: twoStories(), rules: [row], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.questionIds()).toEqual(["s1-r0"]);
    expect(cache.writes.flat()).toHaveLength(1);
    expect(result.cache).toEqual({ remembered: 1, asked: 1 });
  });

  it("re-asks when the rule text changed", async () => {
    const row = activeRule("the new reason");
    const oldHash = storyRelevanceRuleTextHash(row.rule, "the old reason");
    const cache = fakeCache([
      storedAnswer(
        {
          storyRef: "story:a",
          ruleId: row.id,
          ruleTextHash: oldHash,
          modelFingerprint: FINGERPRINT
        },
        "yes",
        FUTURE
      )
    ]);
    const sorting = sortingPort(() => ({ choice: "no", confidence: 0.5 }));

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      {
        candidates: [twoStories()[0]!],
        rules: [row],
        ownerUserId: OWNER,
        now: NOW
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.calls()).toBe(1);
    expect(result.cache).toEqual({ remembered: 0, asked: 1 });
  });

  it("re-asks when the sorting model binding changed", async () => {
    const row = activeRule();
    const cache = fakeCache([
      storedAnswer(keyFor("story:a", row, { modelFingerprint: OLD_FINGERPRINT }), "yes", FUTURE)
    ]);
    const sorting = sortingPort(() => ({ choice: "no", confidence: 0.5 }));

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      { candidates: [twoStories()[0]!], rules: [row], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.calls()).toBe(1);
    expect(result.cache).toEqual({ remembered: 0, asked: 1 });
  });

  it("re-asks when the remembered answer has expired", async () => {
    const row = activeRule();
    const cache = fakeCache([
      storedAnswer(keyFor("story:a", row), "yes", new Date(NOW.getTime() - 1))
    ]);
    const sorting = sortingPort(() => ({ choice: "no", confidence: 0.5 }));

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: sorting.port, answerCache: cache.port },
      { candidates: [twoStories()[0]!], rules: [row], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected an applied result");
    expect(sorting.calls()).toBe(1);
    expect(result.cache).toEqual({ remembered: 0, asked: 1 });
  });

  it("does not remember when no sorting model is bound", async () => {
    const row = activeRule();
    const cache = fakeCache();
    let sortingCalls = 0;
    const jsonCalls: unknown[] = [];
    const port: StoryRelevanceAiPort = {
      async generateJson(_db, input) {
        jsonCalls.push(input);
        return { ok: true as const, object: { verdicts: [] } };
      },
      async sortingModelFingerprint() {
        return null;
      },
      async askSortingQuestions() {
        sortingCalls += 1;
        return { ok: false as const, error: "not_supported" as const };
      }
    };

    const result = await evaluateStoryRelevance(
      SCOPED_DB,
      { ai: port, answerCache: cache.port },
      { candidates: twoStories(), rules: [row], ownerUserId: OWNER, now: NOW }
    );

    expect(result.ok).toBe(true);
    expect(cache.reads).toHaveLength(0);
    expect(cache.writes).toHaveLength(0);
    expect(sortingCalls).toBe(1);
    expect(jsonCalls).toHaveLength(1);
  });

  it("logs remembered and asked counts only", async () => {
    const row = activeRule();
    const cache = fakeCache([storedAnswer(keyFor("story:a", row), "no", FUTURE)]);
    const sorting = sortingPort(() => ({ choice: "yes", confidence: 0.9 }));
    const lines: Record<string, unknown>[] = [];
    const logger: StoryRelevanceLogger = {
      info: (fields) => lines.push(fields),
      warn: (fields) => lines.push(fields)
    };
    const policy = createStoryRelevancePolicy({
      ai: sorting.port,
      repository: { listActiveStoryRules: async () => [row] },
      answerCache: cache.port,
      logger
    });

    await policy(SCOPED_DB, {
      ownerUserId: OWNER,
      moduleId: "news",
      candidates: twoStories(),
      now: NOW
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]?.remembered).toBe(1);
    expect(lines[0]?.asked).toBe(1);
  });
});
