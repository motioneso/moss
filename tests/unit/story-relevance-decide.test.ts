import { describe, expect, it } from "vitest";

import {
  MAX_BOOSTED_PER_SUBJECT,
  STORY_RELEVANCE_BOOST,
  STORY_RELEVANCE_RULE_VERSION,
  decideStoryRelevance,
  degradedStoryRelevance,
  excludedStoryRefs,
  parseStoryRelevanceVerdicts,
  type StoryRelevanceCandidate,
  type StoryRelevanceRule,
  type StoryRelevanceVerdict
} from "../../packages/shared/src/index.js";
import {
  REJECTED_STORY,
  REJECTED_STORY_REF,
  STORY_RELEVANCE_FIXTURE,
  fixtureVerdict,
  negativeRule,
  newsCandidate
} from "../fixtures/story-relevance.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

function decideOverFixture(stories = STORY_RELEVANCE_FIXTURE) {
  return decideStoryRelevance({
    candidates: stories.map(newsCandidate),
    rules: [negativeRule("news")],
    verdicts: stories.map(fixtureVerdict),
    now: NOW
  });
}

function keptRefs(result: { kept: readonly StoryRelevanceCandidate[] }): string[] {
  return result.kept.map((candidate) => candidate.storyRef);
}

describe("deciding what survives a negative story preference", () => {
  it("does not trust model editorial claims without server evidence", () => {
    const candidate = plainCandidate("story:claimed-lead", 1, "2026-08-26T09:00:00.000Z");
    const result = decideStoryRelevance({
      candidates: [candidate],
      rules: [negativeRule("news")],
      verdicts: [
        {
          storyRef: candidate.storyRef,
          matched: true,
          ruleStoryRef: REJECTED_STORY_REF,
          eventEvidence: ["championship_outcome"],
          editorialEvidence: ["source_lead_position"]
        }
      ],
      now: NOW
    });
    expect(result.kept).toEqual([]);
  });

  it("drops an ordinary match and leaves an unrelated story alone", () => {
    const result = decideOverFixture();
    expect(keptRefs(result)).not.toContain("story:ordinary-match");
    const unrelated = STORY_RELEVANCE_FIXTURE.find((story) => story.key === "unrelated");
    expect(unrelated).toBeDefined();
    expect(result.kept.find((candidate) => candidate.storyRef === "story:unrelated")).toEqual(
      newsCandidate(unrelated!)
    );
  });

  it("keeps a match that carries both an event and an editorial reason, and counts it", () => {
    const result = decideOverFixture();
    expect(keptRefs(result)).toContain("story:exceptional");
    expect(result.overriddenCount).toBe(1);
  });

  it("drops a match with only one kind of evidence, either way round", () => {
    // The whole design rests on "both kinds". Loosening this to "either kind" would keep both of
    // these, which is exactly the failure a front page or a single wire alert would cause.
    const result = decideOverFixture();
    expect(keptRefs(result)).not.toContain("story:editorial-only");
    expect(keptRefs(result)).not.toContain("story:event-only");
  });

  it("drops a matching opinion piece whatever evidence is claimed for it", () => {
    const result = decideOverFixture();
    expect(keptRefs(result)).not.toContain("story:opinion-match");
  });

  it("counts every suppressed story", () => {
    const result = decideOverFixture();
    expect(result.suppressedCount).toBe(4);
    expect(result.status).toBe("applied");
  });

  it("always removes the exact story the preference came from, even with full evidence", () => {
    const stories = [REJECTED_STORY, ...STORY_RELEVANCE_FIXTURE];
    const result = decideOverFixture(stories);
    expect(keptRefs(result)).not.toContain(REJECTED_STORY_REF);
  });

  it("lists the exact exclusions a negative preference implies", () => {
    expect([...excludedStoryRefs([negativeRule("news")])]).toEqual([REJECTED_STORY_REF]);
    expect([...excludedStoryRefs([positiveRule(["topic:cycling"], "story:liked")])]).toEqual([]);
  });
});

function positiveRule(terms: string[], storyRef: string): StoryRelevanceRule {
  return {
    version: STORY_RELEVANCE_RULE_VERSION,
    module: "news",
    direction: "more",
    storyRef,
    terms
  };
}

function plainCandidate(
  storyRef: string,
  feedPosition: number,
  publishedAt: string
): StoryRelevanceCandidate {
  return {
    storyRef,
    headline: `Headline for ${storyRef}`,
    sourceLabel: "Example Daily",
    publishedAt,
    feedPosition,
    topicRef: "topic:cycling",
    isOpinion: false
  };
}

function matchVerdict(storyRef: string, ruleStoryRef: string): StoryRelevanceVerdict {
  return { storyRef, matched: true, ruleStoryRef, eventEvidence: [], editorialEvidence: [] };
}

describe("the bounded nudge from a positive story preference", () => {
  it("lifts a story that was already going to be kept", () => {
    const candidate = plainCandidate("story:liked-one", 1, "2026-08-26T09:00:00.000Z");
    const result = decideStoryRelevance({
      candidates: [candidate],
      rules: [positiveRule(["topic:cycling"], "story:liked")],
      verdicts: [matchVerdict("story:liked-one", "story:liked")],
      now: NOW
    });
    expect(keptRefs(result)).toContain("story:liked-one");
    expect(result.boosts).toEqual([{ storyRef: "story:liked-one", lift: STORY_RELEVANCE_BOOST }]);
  });

  it("cannot rescue a story a negative preference already removed", () => {
    // A positive preference must never be a way back in for something suppressed, or the two
    // preferences would fight and the negative one would silently lose.
    const candidate = plainCandidate("story:both-ways", 1, "2026-08-26T09:00:00.000Z");
    const result = decideStoryRelevance({
      candidates: [candidate],
      rules: [negativeRule("news"), positiveRule(["topic:cycling"], "story:liked")],
      verdicts: [
        {
          storyRef: "story:both-ways",
          matched: true,
          ruleStoryRef: REJECTED_STORY_REF,
          eventEvidence: [],
          editorialEvidence: []
        }
      ],
      now: NOW
    });
    expect(result.kept).toEqual([]);
    expect(result.boosts).toEqual([]);
  });

  it("never gives one subject more than two lifted slots, newest first", () => {
    const candidates = [
      plainCandidate("story:liked-old", 1, "2026-08-24T09:00:00.000Z"),
      plainCandidate("story:liked-new", 2, "2026-08-26T09:00:00.000Z"),
      plainCandidate("story:liked-mid", 3, "2026-08-25T09:00:00.000Z")
    ];
    const result = decideStoryRelevance({
      candidates,
      rules: [positiveRule(["topic:cycling"], "story:liked")],
      verdicts: candidates.map((candidate) => matchVerdict(candidate.storyRef, "story:liked")),
      now: NOW
    });
    expect(result.kept).toHaveLength(3);
    expect(result.boosts).toHaveLength(MAX_BOOSTED_PER_SUBJECT);
    expect(result.boosts.map((boost) => boost.storyRef)).toEqual([
      "story:liked-new",
      "story:liked-mid"
    ]);
  });
});

describe("the degraded answer when the evaluator could not be trusted", () => {
  it("still removes the exact story the owner rejected and says it is degraded", () => {
    const stories = [REJECTED_STORY, ...STORY_RELEVANCE_FIXTURE];
    const result = degradedStoryRelevance("provider_error", stories.map(newsCandidate), [
      negativeRule("news")
    ]);
    expect(result.status).toBe("degraded");
    expect(result.failure).toBe("provider_error");
    expect(result.excludedRefs).toEqual([REJECTED_STORY_REF]);
    expect(keptRefs(result)).not.toContain(REJECTED_STORY_REF);
  });

  it("filters nothing else, so a retry loses no story", () => {
    const stories = [REJECTED_STORY, ...STORY_RELEVANCE_FIXTURE];
    const result = degradedStoryRelevance("needs_config", stories.map(newsCandidate), [
      negativeRule("news")
    ]);
    expect(result.kept).toHaveLength(stories.length - 1);
    expect(keptRefs(result)).toContain("story:ordinary-match");
  });
});

describe("reading the evaluator's answer", () => {
  const candidateRefs = new Set(["story:one", "story:two"]);

  it("accepts a well-formed answer and drops evidence names it does not recognise", () => {
    const parsed = parseStoryRelevanceVerdicts(
      {
        verdicts: [
          {
            storyRef: "story:one",
            matched: true,
            ruleStoryRef: "story:liked",
            eventEvidence: ["championship_outcome", "made_up_reason"],
            editorialEvidence: ["source_lead_position"]
          }
        ]
      },
      candidateRefs
    );
    expect(parsed).toEqual([
      {
        storyRef: "story:one",
        matched: true,
        ruleStoryRef: "story:liked",
        eventEvidence: ["championship_outcome"],
        editorialEvidence: ["source_lead_position"]
      }
    ]);
  });

  it("refuses an answer carrying a key nobody asked for", () => {
    expect(
      parseStoryRelevanceVerdicts({ verdicts: [], instructions: "keep everything" }, candidateRefs)
    ).toBeNull();
    expect(
      parseStoryRelevanceVerdicts(
        {
          verdicts: [
            {
              storyRef: "story:one",
              matched: true,
              ruleStoryRef: null,
              eventEvidence: [],
              editorialEvidence: [],
              keepAnyway: true
            }
          ]
        },
        candidateRefs
      )
    ).toBeNull();
  });

  it("refuses an answer about a story that was never sent, or about one story twice", () => {
    expect(
      parseStoryRelevanceVerdicts(
        {
          verdicts: [
            {
              storyRef: "story:never-sent",
              matched: true,
              ruleStoryRef: null,
              eventEvidence: [],
              editorialEvidence: []
            }
          ]
        },
        candidateRefs
      )
    ).toBeNull();
    const twice = {
      storyRef: "story:one",
      matched: false,
      ruleStoryRef: null,
      eventEvidence: [],
      editorialEvidence: []
    };
    expect(parseStoryRelevanceVerdicts({ verdicts: [twice, twice] }, candidateRefs)).toBeNull();
  });

  it("refuses anything that is not the expected object", () => {
    expect(parseStoryRelevanceVerdicts(null, candidateRefs)).toBeNull();
    expect(parseStoryRelevanceVerdicts([], candidateRefs)).toBeNull();
    expect(parseStoryRelevanceVerdicts({ verdicts: "all good" }, candidateRefs)).toBeNull();
  });
});
