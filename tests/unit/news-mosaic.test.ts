import { describe, expect, it } from "vitest";

import { composeMosaic, interleaveGroups } from "../../packages/news/src/web/news-mosaic.js";
import type { NewsHeadline, NewsSourceGroup } from "@moss/shared";

// #897: composeMosaic is pure layout planning — which headline gets the feature slot, which get
// major (art) cards, which fall to standards/briefs. Pin it here so a CSS-era refactor can't
// silently drop stories between tiers.
let counter = 0;
function headline(overrides: Partial<NewsHeadline> = {}): NewsHeadline {
  counter += 1;
  return {
    id: `h-${counter}`,
    title: `Headline ${counter}`,
    url: `https://example.com/${counter}`,
    publishedAt: "2026-07-08T12:00:00.000Z",
    imageUrl: null,
    faviconUrl: null,
    summary: "",
    sourceKey: "bbc",
    sourceLabel: "BBC News",
    topicKey: null,
    topicLabel: null,
    ...overrides
  };
}

const art = { imageUrl: "https://ichef.bbci.co.uk/img.png" };
const dek = { summary: "A dek." };

describe("composeMosaic (#897)", () => {
  it("features the first feature-eligible headline and excludes it from every other tier", () => {
    const plain = headline();
    const feature = headline({ ...art, ...dek });
    const also = headline({ ...art, ...dek });
    const plan = composeMosaic([plain, feature, also]);

    expect(plan.feature).toBe(feature);
    // Exclusion is by object identity — the same story must never render twice.
    expect(plan.mosaic).not.toContain(feature);
    expect(plan.briefs).not.toContain(feature);
    expect(plan.mosaic).toContain(also);
  });

  it("returns a null feature when nothing qualifies (art-only pool)", () => {
    const plan = composeMosaic([headline(art), headline(art)]);
    expect(plan.feature).toBeNull();
  });

  it("splits the remainder into 2 majors (art required), 6 standards, 10 briefs", () => {
    const feature = headline({ ...art, ...dek });
    const withArt = [headline(art), headline(art), headline(art)];
    const plain = Array.from({ length: 20 }, () => headline());
    const pool = [feature, ...withArt, ...plain];

    const plan = composeMosaic(pool);

    // majors = first two art-bearing stories after the feature; the third art story overflows
    // into the flow like any standard.
    const mosaicIds = plan.mosaic.map((h) => h.id);
    expect(mosaicIds).toContain(withArt[0]!.id);
    expect(mosaicIds).toContain(withArt[1]!.id);

    // flow = rest minus majors = [withArt[2], ...plain] (21 items):
    // standards = flow[0..5] (6), briefs = flow[6..15] (10), overflow beyond 16 is dropped.
    expect(plan.mosaic).toHaveLength(8); // 2 majors + 6 standards
    expect(plan.briefs).toHaveLength(10);
    expect(plan.briefs[0]).toBe(plain[5]); // flow[6] = plain[5] after withArt[2]+plain[0..4]

    // mosaic preserves pool order (reads left-to-right like a front page).
    const poolOrder = pool.map((h) => h.id);
    expect(mosaicIds).toEqual(poolOrder.filter((id) => mosaicIds.includes(id)));
  });

  it("handles a small pool without padding tiers", () => {
    const feature = headline({ ...art, ...dek });
    const only = headline();
    const plan = composeMosaic([feature, only]);
    expect(plan.feature).toBe(feature);
    expect(plan.mosaic).toEqual([only]);
    expect(plan.briefs).toEqual([]);
  });

  it("handles an empty pool (degraded overview with zero feeds)", () => {
    const plan = composeMosaic([]);
    expect(plan.feature).toBeNull();
    expect(plan.mosaic).toEqual([]);
    expect(plan.briefs).toEqual([]);
  });
});

describe("interleaveGroups (#897)", () => {
  function group(sourceKey: string, headlines: NewsHeadline[]): NewsSourceGroup {
    return {
      sourceKey,
      sourceLabel: sourceKey.toUpperCase(),
      homepageUrl: `https://${sourceKey}.example`,
      headlines
    };
  }

  it("round-robins across groups so one prolific source can't monopolize the pool", () => {
    const a1 = headline();
    const a2 = headline();
    const a3 = headline();
    const b1 = headline();
    const c1 = headline();
    const c2 = headline();

    const merged = interleaveGroups([
      group("a", [a1, a2, a3]),
      group("b", [b1]),
      group("c", [c1, c2])
    ]);
    // Position 0 of every group, then position 1 (skipping exhausted groups), then position 2.
    expect(merged).toEqual([a1, b1, c1, a2, c2, a3]);
  });

  it("returns [] for no groups", () => {
    expect(interleaveGroups([])).toEqual([]);
  });
});
