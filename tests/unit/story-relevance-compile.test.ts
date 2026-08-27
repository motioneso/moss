import { describe, expect, it } from "vitest";

import {
  MAX_STORY_RULE_TERMS,
  STORY_RELEVANCE_RULE_VERSION
} from "../../packages/shared/src/index.js";
import {
  compileStoryRelevanceRule,
  storyRelevanceRuleNeedsRecompile
} from "../../packages/usefulness-feedback/src/relevance/compile.js";

const SPORTS_CONTEXT = {
  module: "sports",
  headline: "Riverside sign another winger",
  sourceLabel: "Example Sport",
  teamRef: "team:riverside",
  competitionRef: "competition:premier"
};

const NEWS_CONTEXT = {
  module: "news",
  headline: "Another transfer rumour",
  sourceLabel: "Example Daily",
  topicRef: "topic:transfer-gossip"
};

describe("compiling a saved story preference into a rule", () => {
  it("prefers the stable Sports identifiers over words taken from the reason", () => {
    // An identifier does not drift; a club's display name does. If the reason's words came first,
    // a rule would quietly stop matching the moment a source renamed something.
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "less",
      storyRef: "story:one",
      context: SPORTS_CONTEXT,
      reasonText: "I am sick of transfer rumours about Riverside"
    });
    expect(rule.terms.slice(0, 2)).toEqual(["team:riverside", "competition:premier"]);
    expect(rule.module).toBe("sports");
    expect(rule.direction).toBe("less");
    expect(rule.storyRef).toBe("story:one");
    expect(rule.version).toBe(STORY_RELEVANCE_RULE_VERSION);
  });

  it("uses the verified topic for a News preference", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:two",
      context: NEWS_CONTEXT,
      reasonText: "Too much of this"
    });
    expect(rule.terms[0]).toBe("topic:transfer-gossip");
  });

  it("lower-cases, strips punctuation, drops filler words and de-duplicates reason terms", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:three",
      context: { module: "news" },
      reasonText: "The Cricket, the CRICKET and a bit more of the cricket!"
    });
    expect(rule.terms).toContain("cricket");
    expect(rule.terms.filter((term) => term === "cricket")).toHaveLength(1);
    expect(rule.terms).not.toContain("the");
    expect(rule.terms).not.toContain("and");
    expect(rule.terms.every((term) => term === term.toLowerCase())).toBe(true);
    expect(rule.terms.every((term) => !/[.,!?]/.test(term))).toBe(true);
  });

  it("keeps only terms of a sensible length and never more than eight", () => {
    const reason = [
      "a",
      "of",
      "x".repeat(60),
      ...Array.from({ length: 20 }, (_, index) => `subject${index}`)
    ].join(" ");
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:four",
      context: { module: "news" },
      reasonText: reason
    });
    expect(rule.terms).toHaveLength(MAX_STORY_RULE_TERMS);
    expect(rule.terms).not.toContain("a");
    expect(rule.terms.every((term) => term.length >= 2 && term.length <= 40)).toBe(true);
  });

  it("compiles a more-like-this preference from the record alone, with no reason", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "more",
      storyRef: "story:five",
      context: SPORTS_CONTEXT
    });
    expect(rule.direction).toBe("more");
    expect(rule.terms).toEqual(["team:riverside", "competition:premier"]);
  });

  it("never keeps a copy of the reason anywhere in the rule", () => {
    // The reason has exactly one home, its own column. A second copy inside the rule would travel
    // wherever the rule travels, which is the leak #2016 was careful to close.
    const reason = "I cannot stand the endless Riverside transfer gossip, it is exhausting";
    const rule = compileStoryRelevanceRule({
      moduleId: "sports",
      direction: "less",
      storyRef: "story:six",
      context: SPORTS_CONTEXT,
      reasonText: reason
    });
    const serialized = JSON.stringify(rule);
    expect(serialized).not.toContain(reason);
    // Not one phrase of it either: the rule keeps single derived subject words, never the owner's
    // own wording, so nothing readable travels with the rule.
    expect(serialized).not.toContain("cannot stand");
    expect(serialized).not.toContain("transfer gossip");
    expect(rule.terms.every((term) => !term.includes(" "))).toBe(true);
  });

  it("survives a story with no useful context and no reason at all", () => {
    const rule = compileStoryRelevanceRule({
      moduleId: "news",
      direction: "less",
      storyRef: "story:seven",
      context: {},
      reasonText: null
    });
    expect(rule.terms).toEqual([]);
    expect(rule.storyRef).toBe("story:seven");
  });
});

describe("spotting a rule that has to be built again", () => {
  const good = {
    version: STORY_RELEVANCE_RULE_VERSION,
    module: "news",
    direction: "less",
    storyRef: "story:one",
    terms: ["topic:one"]
  };

  it("leaves a current, well-formed rule alone", () => {
    expect(storyRelevanceRuleNeedsRecompile(good, STORY_RELEVANCE_RULE_VERSION)).toBe(false);
  });

  it("rebuilds the empty rule every row saved before this change carries", () => {
    expect(storyRelevanceRuleNeedsRecompile({}, null)).toBe(true);
  });

  it("rebuilds an older version, or anything that is not a rule", () => {
    expect(storyRelevanceRuleNeedsRecompile({ ...good, version: 0 }, 0)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile(good, null)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile("not a rule", 1)).toBe(true);
    expect(storyRelevanceRuleNeedsRecompile(null, 1)).toBe(true);
  });
});
