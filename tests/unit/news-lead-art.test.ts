import { describe, expect, it } from "vitest";

import {
  drawLeadContours,
  leadArtPalette,
  leadArtSeed,
  type LeadArtLine,
  type LeadArtPalette
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
    expect(drawLeadContours(seed, "climate")).toEqual(
      drawLeadContours(leadArtSeed({ ...story }), "climate")
    );
  });

  it("ignores surrounding whitespace and Unicode compatibility forms in the seed", () => {
    expect(leadArtSeed({ ...story, headline: `  ${story.headline} ` })).toBe(leadArtSeed(story));
    expect(leadArtSeed({ ...story, publisher: "ＮＰＲ" })).toBe(leadArtSeed(story));
  });

  it("draws different contours for a different story", () => {
    const other = { ...story, headline: "The public spaces that bring a city together" };
    expect(leadArtSeed(other)).not.toBe(leadArtSeed(story));
    expect(drawLeadContours(leadArtSeed(other), "climate")).not.toEqual(
      drawLeadContours(leadArtSeed(story), "climate")
    );
    expect(leadArtSeed({ ...story, publisher: "BBC News" })).not.toBe(leadArtSeed(story));
    expect(leadArtSeed({ ...story, topic: "World" })).not.toBe(leadArtSeed(story));
  });

  it("traces visible contour lines with a gold line at every fifth level for every topic", () => {
    for (const kind of KINDS) {
      const lines = drawLeadContours(leadArtSeed(story), kind);
      expect(lines.length).toBeGreaterThan(3);
      expect(lines.some((line) => line.gold)).toBe(true);
      expect(lines.some((line) => !line.gold)).toBe(true);
      for (const line of lines) expect(line.d).toMatch(/^M[\d.-]+,[\d.-]+L/);
    }
  });

  it("gives the same story a different terrain under each topic", () => {
    const seed = leadArtSeed(story);
    const drawings = KINDS.map((kind) => JSON.stringify(drawLeadContours(seed, kind)));
    expect(new Set(drawings).size).toBe(KINDS.length);
  });

  it("draws a terrain shape that identifies the topic across many stories", () => {
    for (const kind of KINDS) {
      for (let index = 0; index < 12; index += 1) {
        const seed = leadArtSeed({ topic: kind, headline: `Story ${index}`, publisher: "AP" });
        expect({ kind, index, terrain: terrainOf(drawLeadContours(seed, kind)) }).toEqual({
          kind,
          index,
          terrain: kind
        });
      }
    }
  });

  it("draws built-in object names as World terrain without throwing", () => {
    for (const topic of ["constructor", "__proto__"]) {
      const seed = leadArtSeed({ ...story, topic });
      expect(drawLeadContours(seed, leadArtPalette(topic)).length).toBeGreaterThan(0);
    }
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
    expect(leadArtPalette("constructor")).toBe("world");
    expect(leadArtPalette("__proto__")).toBe("world");
    expect(leadArtPalette("toString")).toBe("world");
  });
});

const KINDS: readonly LeadArtPalette[] = ["climate", "world", "culture", "technology"];

/**
 * Names the terrain from the traced lines alone, using the traits each topic is meant to show:
 * technology runs straight in two directions, world closes tight rings round a summit, culture
 * sends dense bands from edge to edge, and climate spaces a few soft lines wide apart.
 */
function terrainOf(lines: readonly LeadArtLine[]): LeadArtPalette | "unknown" {
  const directions = new Array<number>(18).fill(0);
  let ink = 0;
  let edgeToEdge = 0;
  for (const line of lines) {
    const numbers = line.d.match(/-?[\d.]+/g)!.map(Number);
    let left = false;
    let right = false;
    for (let index = 0; index < numbers.length; index += 4) {
      const [x1, y1, x2, y2] = numbers.slice(index, index + 4) as [number, number, number, number];
      const length = Math.hypot(x2 - x1, y2 - y1);
      const degrees = ((Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI + 180) % 180;
      directions[Math.min(17, Math.floor(degrees / 10))]! += length;
      ink += length;
      left ||= Math.min(x1, x2) <= 1;
      right ||= Math.max(x1, x2) >= 799;
    }
    if (left && right) edgeToEdge += 1;
  }
  directions.sort((a, b) => b - a);
  const straightShare = (directions[0]! + directions[1]!) / ink;
  const edgeShare = edgeToEdge / lines.length;

  if (straightShare >= 0.7) return "technology";
  if (edgeShare <= 0.2 && lines.length >= 20) return "world";
  if (edgeShare >= 0.5 && ink >= 20000) return "culture";
  if (lines.length < 20 && ink < 18000) return "climate";
  return "unknown";
}
