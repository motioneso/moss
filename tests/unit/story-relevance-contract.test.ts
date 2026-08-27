import { describe, expect, it } from "vitest";

import type { DataContextDb } from "../../packages/db/src/index.js";
import {
  decideStoryRelevance,
  type StoryFeedbackModule,
  type StoryRelevanceCandidate
} from "../../packages/shared/src/index.js";
import {
  createStoryRelevancePolicy,
  type StoryRelevanceLogger
} from "../../packages/usefulness-feedback/src/relevance/policy.js";
import type { ActiveStoryRuleRow } from "../../packages/usefulness-feedback/src/repository.js";
import {
  REJECTED_STORY,
  REJECTED_STORY_REF,
  STORY_RELEVANCE_FIXTURE,
  fixtureVerdict,
  negativeRule,
  newsCandidate,
  sportsCandidate
} from "../fixtures/story-relevance.js";

/**
 * Case 15: the same stories must get the same answers whichever module asks.
 *
 * News and Sports carry different metadata about a story - News has a topic, Sports has a team and
 * a competition - so it would be easy for the two to drift apart over time until a person sees a
 * preference honoured in one place and ignored in the other. Running one fixture through both
 * adapters is what stops that happening quietly.
 */

const NOW = new Date("2026-08-26T12:00:00.000Z");
const SCOPED_DB = {} as DataContextDb;
const OWNER = "22222222-2222-4222-8222-222222222222";
const ALL_STORIES = [REJECTED_STORY, ...STORY_RELEVANCE_FIXTURE];

const silentLogger: StoryRelevanceLogger = { info: () => {}, warn: () => {} };

function adapterFor(
  moduleId: StoryFeedbackModule
): (story: (typeof ALL_STORIES)[number]) => StoryRelevanceCandidate {
  return moduleId === "sports" ? sportsCandidate : newsCandidate;
}

function activeRuleRow(moduleId: StoryFeedbackModule): ActiveStoryRuleRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    targetRef: REJECTED_STORY_REF,
    direction: "less",
    reasonText: "Less of this subject please",
    rule: negativeRule(moduleId)
  };
}

async function keptThroughPolicy(moduleId: StoryFeedbackModule): Promise<string[]> {
  const policy = createStoryRelevancePolicy({
    ai: {
      async generateJson() {
        return { ok: true, object: { verdicts: ALL_STORIES.map(fixtureVerdict) } };
      }
    },
    repository: { listActiveStoryRules: async () => [activeRuleRow(moduleId)] },
    logger: silentLogger
  });
  const result = await policy(SCOPED_DB, {
    ownerUserId: OWNER,
    moduleId,
    candidates: ALL_STORIES.map(adapterFor(moduleId)),
    now: NOW
  });
  return result.kept.map((candidate) => candidate.storyRef);
}

describe("story relevance contract", () => {
  it("reaches the same decisions through the News adapter and the Sports adapter", async () => {
    const news = await keptThroughPolicy("news");
    const sports = await keptThroughPolicy("sports");
    expect(sports).toEqual(news);
  });

  it("keeps exactly the stories the fixture says should survive, in either module", async () => {
    const expected = ALL_STORIES.filter((story) => story.expectKept).map((story) => story.storyRef);
    expect(await keptThroughPolicy("news")).toEqual(expected);
    expect(await keptThroughPolicy("sports")).toEqual(expected);
  });

  it("makes the same decisions in the pure layer for both adapters", () => {
    for (const moduleId of ["news", "sports"] as const) {
      const decided = decideStoryRelevance({
        candidates: ALL_STORIES.map(adapterFor(moduleId)),
        rules: [negativeRule(moduleId)],
        verdicts: ALL_STORIES.map(fixtureVerdict),
        now: NOW
      });
      expect(decided.kept.map((candidate) => candidate.storyRef)).toEqual(
        ALL_STORIES.filter((story) => story.expectKept).map((story) => story.storyRef)
      );
      expect(decided.overriddenCount).toBe(1);
    }
  });
});
