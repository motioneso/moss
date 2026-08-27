import { describe, expect, it } from "vitest";

import {
  buildStoryTargetContext,
  sanitizeStoryTargetMetadata,
  storyFeedbackTargetRef
} from "../../packages/usefulness-feedback/src/story-target.js";

describe("story feedback identity helper", () => {
  it("derives a stable, opaque story reference that differs per link and per module", () => {
    const link = "https://news.example.com/2026/08/a-story?utm_source=feed";
    expect(storyFeedbackTargetRef("news", link)).toBe(storyFeedbackTargetRef("news", link));
    expect(storyFeedbackTargetRef("news", link)).not.toBe(
      storyFeedbackTargetRef("news", "https://news.example.com/2026/08/another-story")
    );
    expect(storyFeedbackTargetRef("news", link)).not.toBe(storyFeedbackTargetRef("sports", link));

    const ref = storyFeedbackTargetRef("news", link);
    expect(ref).not.toContain("news.example.com");
    expect(ref).not.toContain("a-story");
    expect(ref).not.toContain("utm_source");
    expect(ref.startsWith("news:")).toBe(true);
  });

  it("refuses a story with no canonical link", () => {
    expect(() => storyFeedbackTargetRef("news", "   ")).toThrow(/canonical link/);
  });
});

describe("story target context cleaner", () => {
  it("keeps only the agreed keys and drops anything else", () => {
    const cleaned = sanitizeStoryTargetMetadata({
      module: "news",
      headline: "A headline",
      topicRef: "transfers",
      isOpinion: true,
      summary: "the whole article body",
      externalId: "provider-123",
      raw: { anything: "at all" }
    });
    expect(cleaned).toEqual({
      module: "news",
      headline: "A headline",
      topicRef: "transfers",
      isOpinion: true
    });
  });

  it("returns an empty shape for nothing at all", () => {
    expect(sanitizeStoryTargetMetadata(undefined)).toEqual({});
  });

  it("leaves what the builder produces untouched", () => {
    const built = buildStoryTargetContext({
      moduleId: "sports",
      headline: "  A   spaced   headline  ",
      sourceLabel: "Sports",
      teamRef: "team-a",
      isOpinion: false
    });
    expect(sanitizeStoryTargetMetadata(built)).toEqual(built);
    expect(built.headline).toBe("A spaced headline");
  });
});
