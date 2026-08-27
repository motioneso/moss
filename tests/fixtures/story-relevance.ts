import type {
  StoryFeedbackModule,
  StoryRelevanceCandidate,
  StoryRelevanceRule,
  StoryRelevanceVerdict
} from "../../packages/shared/src/index.js";
import { STORY_RELEVANCE_RULE_VERSION } from "../../packages/shared/src/index.js";

/**
 * One shared set of stories every story-relevance test works from.
 *
 * The point of a single fixture is drift: News and Sports must reach the same keep/drop answers for
 * the same shapes, and the only way to keep that true is to run both adapters over identical
 * material. Each story below exists to pin one rule:
 *
 * - `ordinaryMatch` - matches the negative preference and carries nothing exceptional, so it goes.
 * - `unrelated` - matches nothing and must survive completely untouched.
 * - `exceptional` - matches, and carries both an event code and an editorial code, so it stays.
 * - `editorialOnly` - looks important and carries editorial evidence only, so it must still go.
 *   This is the one a loosened "either kind of evidence" rule would wrongly keep.
 * - `opinionMatch` - matches and claims full evidence, but the record says it is an opinion piece.
 * - `positiveMatch*` - three stories under one positive preference, to pin the two-slot cap.
 */

export const REJECTED_STORY_REF = "story:rejected";

export interface StoryRelevanceFixtureStory {
  readonly key: string;
  readonly storyRef: string;
  readonly headline: string;
  readonly sourceLabel: string;
  readonly publishedAt: string;
  readonly feedPosition: number;
  readonly topicRef: string | null;
  readonly teamRef: string | null;
  readonly competitionRef: string | null;
  readonly isOpinion: boolean;
  /** What the evaluator is expected to say about this story. */
  readonly verdict: {
    readonly matched: boolean;
    readonly ruleStoryRef: string | null;
    readonly eventEvidence: readonly string[];
    readonly editorialEvidence: readonly string[];
  };
  /** What our own code must decide, whatever the evaluator claimed. */
  readonly expectKept: boolean;
}

export const STORY_RELEVANCE_FIXTURE: readonly StoryRelevanceFixtureStory[] = [
  {
    key: "ordinaryMatch",
    storyRef: "story:ordinary-match",
    headline: "Routine coverage of the subject the owner asked to see less of",
    sourceLabel: "Example Wire",
    publishedAt: "2026-08-26T09:00:00.000Z",
    feedPosition: 1,
    topicRef: "topic:transfer-gossip",
    teamRef: "team:riverside",
    competitionRef: "competition:premier",
    isOpinion: false,
    verdict: {
      matched: true,
      ruleStoryRef: REJECTED_STORY_REF,
      eventEvidence: [],
      editorialEvidence: []
    },
    expectKept: false
  },
  {
    key: "unrelated",
    storyRef: "story:unrelated",
    headline: "A story about something else entirely",
    sourceLabel: "Example Daily",
    publishedAt: "2026-08-26T08:00:00.000Z",
    feedPosition: 2,
    topicRef: "topic:local-transport",
    teamRef: null,
    competitionRef: null,
    isOpinion: false,
    verdict: { matched: false, ruleStoryRef: null, eventEvidence: [], editorialEvidence: [] },
    expectKept: true
  },
  {
    key: "exceptional",
    storyRef: "story:exceptional",
    headline: "The subject reaches a genuinely consequential moment",
    sourceLabel: "Example Wire",
    publishedAt: "2026-08-26T07:00:00.000Z",
    feedPosition: 3,
    topicRef: "topic:transfer-gossip",
    teamRef: "team:riverside",
    competitionRef: "competition:premier",
    isOpinion: false,
    verdict: {
      matched: true,
      ruleStoryRef: REJECTED_STORY_REF,
      eventEvidence: ["championship_outcome"],
      editorialEvidence: ["source_lead_position"]
    },
    expectKept: true
  },
  {
    key: "editorialOnly",
    storyRef: "story:editorial-only",
    headline: "The subject is given the front page but nothing has actually happened",
    sourceLabel: "Example Daily",
    publishedAt: "2026-08-26T06:00:00.000Z",
    feedPosition: 4,
    topicRef: "topic:transfer-gossip",
    teamRef: "team:riverside",
    competitionRef: "competition:premier",
    isOpinion: false,
    verdict: {
      matched: true,
      ruleStoryRef: REJECTED_STORY_REF,
      eventEvidence: [],
      editorialEvidence: ["source_lead_position", "cross_publisher_coverage"]
    },
    expectKept: false
  },
  {
    key: "eventOnly",
    storyRef: "story:event-only",
    headline: "The subject is caught up in something real that no editor has led on",
    sourceLabel: "Example Wire",
    publishedAt: "2026-08-26T05:00:00.000Z",
    feedPosition: 5,
    topicRef: "topic:transfer-gossip",
    teamRef: "team:riverside",
    competitionRef: "competition:premier",
    isOpinion: false,
    verdict: {
      matched: true,
      ruleStoryRef: REJECTED_STORY_REF,
      eventEvidence: ["consequential_civic_event"],
      editorialEvidence: []
    },
    expectKept: false
  },
  {
    key: "opinionMatch",
    storyRef: "story:opinion-match",
    headline: "A columnist on the subject, claiming to be the most important thing today",
    sourceLabel: "Example Daily",
    publishedAt: "2026-08-26T04:00:00.000Z",
    feedPosition: 6,
    topicRef: "topic:transfer-gossip",
    teamRef: "team:riverside",
    competitionRef: "competition:premier",
    isOpinion: true,
    verdict: {
      matched: true,
      ruleStoryRef: REJECTED_STORY_REF,
      eventEvidence: ["terrorism_or_mass_casualty", "war_escalation"],
      editorialEvidence: ["source_lead_position", "cross_publisher_coverage"]
    },
    expectKept: false
  }
];

/** The story the owner rejected. It must always be excluded, whatever anyone claims about it. */
export const REJECTED_STORY: StoryRelevanceFixtureStory = {
  key: "rejected",
  storyRef: REJECTED_STORY_REF,
  headline: "The very story the owner said less of",
  sourceLabel: "Example Wire",
  publishedAt: "2026-08-26T10:00:00.000Z",
  feedPosition: 0,
  topicRef: "topic:transfer-gossip",
  teamRef: "team:riverside",
  competitionRef: "competition:premier",
  isOpinion: false,
  verdict: {
    matched: true,
    ruleStoryRef: REJECTED_STORY_REF,
    eventEvidence: ["championship_outcome", "historic_record"],
    editorialEvidence: ["source_lead_position", "event_stage_metadata"]
  },
  expectKept: false
};

export function negativeRule(moduleId: StoryFeedbackModule): StoryRelevanceRule {
  return {
    version: STORY_RELEVANCE_RULE_VERSION,
    module: moduleId,
    direction: "less",
    storyRef: REJECTED_STORY_REF,
    terms:
      moduleId === "sports" ? ["team:riverside", "competition:premier"] : ["topic:transfer-gossip"]
  };
}

/** The News adapter: a News-shaped row mapped into the neutral candidate shape. */
export function newsCandidate(story: StoryRelevanceFixtureStory): StoryRelevanceCandidate {
  return {
    storyRef: story.storyRef,
    headline: story.headline,
    sourceLabel: story.sourceLabel,
    publishedAt: story.publishedAt,
    feedPosition: story.feedPosition,
    topicRef: story.topicRef,
    isOpinion: story.isOpinion
  };
}

/** The Sports adapter: the same story, carrying the honest metadata Sports actually has. */
export function sportsCandidate(story: StoryRelevanceFixtureStory): StoryRelevanceCandidate {
  return {
    storyRef: story.storyRef,
    headline: story.headline,
    sourceLabel: story.sourceLabel,
    publishedAt: story.publishedAt,
    feedPosition: story.feedPosition,
    teamRef: story.teamRef,
    competitionRef: story.competitionRef,
    isOpinion: story.isOpinion
  };
}

export function fixtureVerdict(story: StoryRelevanceFixtureStory): StoryRelevanceVerdict {
  return {
    storyRef: story.storyRef,
    matched: story.verdict.matched,
    ruleStoryRef: story.verdict.ruleStoryRef,
    eventEvidence: story.verdict.eventEvidence as StoryRelevanceVerdict["eventEvidence"],
    editorialEvidence: story.verdict.editorialEvidence as StoryRelevanceVerdict["editorialEvidence"]
  };
}
