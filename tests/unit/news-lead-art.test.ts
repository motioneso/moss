import { describe, expect, it } from "vitest";

import {
  drawLeadContours,
  leadArtPalette,
  leadArtSeed
} from "../../packages/news/src/web/lead-art.js";

const story = {
  topic: "Climate",
  headline: "Cities are making more room for trees",
  publisher: "NPR"
};

describe("News lead topic art", () => {
  it("draws the same contours for the same story", () => {
    const seed = leadArtSeed(story);
    expect(leadArtSeed({ ...story })).toBe(seed);
    expect(drawLeadContours(seed)).toEqual(drawLeadContours(leadArtSeed({ ...story })));
  });

  it("ignores surrounding whitespace and Unicode compatibility forms in the seed", () => {
    expect(leadArtSeed({ ...story, headline: `  ${story.headline} ` })).toBe(leadArtSeed(story));
    expect(leadArtSeed({ ...story, publisher: "ＮＰＲ" })).toBe(leadArtSeed(story));
  });

  it("draws different contours for a different story", () => {
    const other = { ...story, headline: "The public spaces that bring a city together" };
    expect(leadArtSeed(other)).not.toBe(leadArtSeed(story));
    expect(drawLeadContours(leadArtSeed(other))).not.toEqual(drawLeadContours(leadArtSeed(story)));
    expect(leadArtSeed({ ...story, publisher: "BBC News" })).not.toBe(leadArtSeed(story));
    expect(leadArtSeed({ ...story, topic: "World" })).not.toBe(leadArtSeed(story));
  });

  it("traces visible contour lines with a gold line at every fifth level", () => {
    const lines = drawLeadContours(leadArtSeed(story));
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.some((line) => line.gold)).toBe(true);
    expect(lines.some((line) => !line.gold)).toBe(true);
    for (const line of lines) expect(line.d).toMatch(/^M[\d.-]+,[\d.-]+L/);
  });

  it("picks a color pair from the topic and falls back to World", () => {
    expect(leadArtPalette("Climate")).toBe("climate");
    expect(leadArtPalette("science")).toBe("climate");
    expect(leadArtPalette("World")).toBe("world");
    expect(leadArtPalette("U.S.")).toBe("world");
    expect(leadArtPalette("Culture")).toBe("culture");
    expect(leadArtPalette(" Technology ")).toBe("technology");
    expect(leadArtPalette("business")).toBe("technology");
    expect(leadArtPalette("Sport")).toBe("world");
    expect(leadArtPalette("")).toBe("world");
    expect(leadArtPalette(null)).toBe("world");
  });
});
