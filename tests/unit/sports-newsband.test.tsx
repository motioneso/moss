import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Headline, LeagueNewsGroup } from "@moss/shared";
import { NewsBand } from "../../packages/sports/src/web/sports-news.js";

// A first-of-league headline with art (+2) + dek (+1) clears BIG_STORY_WEIGHT (4) on the
// first-of-league bonus (+2) → it becomes the FeatureArticle, which is where the #857 body renders.
function headline(over: Partial<Headline> = {}): Headline {
  return {
    id: "4567",
    competitionKey: "nfl",
    competitionLabel: "NFL",
    title: "Cowboys clinch the NFC East",
    url: "https://www.espn.com/nfl/story/_/id/4567",
    publishedAt: "2026-07-07T12:00:00.000Z",
    imageUrl: "https://a.espncdn.com/photo/cowboys.jpg",
    summary: "Dallas wrapped up the division on Sunday.",
    teamKeys: [],
    publisherLabel: "ESPN",
    publisherDomain: "espn.com",
    ...over
  };
}

function group(h: Headline): LeagueNewsGroup {
  return { competitionKey: "nfl", competitionLabel: "NFL", headlines: [h] };
}

describe("NewsBand featured-article body (#857)", () => {
  it("renders the fetched body as multiple paragraphs when present", () => {
    const html = renderToString(
      createElement(NewsBand, {
        groups: [group(headline({ body: "First paragraph.\n\nSecond paragraph." }))],
        followedPairs: new Set<string>()
      })
    );
    expect(html).toContain("sp-newsband__feature");
    // Body split on blank lines → two feature blurb paragraphs, not the one-line dek.
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
    const blurbCount = html.split("sp-newsband__blurb--feature").length - 1;
    expect(blurbCount).toBe(2);
    // The dek is superseded by the body, so it must not also render.
    expect(html).not.toContain("Dallas wrapped up the division on Sunday.");
  });

  it("falls back to the one-paragraph dek when no body came through", () => {
    const html = renderToString(
      createElement(NewsBand, {
        groups: [group(headline())], // no body
        followedPairs: new Set<string>()
      })
    );
    expect(html).toContain("sp-newsband__feature");
    expect(html).toContain("Dallas wrapped up the division on Sunday.");
    const blurbCount = html.split("sp-newsband__blurb--feature").length - 1;
    expect(blurbCount).toBe(1);
  });
});

describe("NewsBand majors/mosaic url-keying (#858)", () => {
  it("keys majors/mosaic by url, not id, so a same-id different-story headline isn't wrongly promoted to major", () => {
    const items: Headline[] = [
      headline({
        id: "a0",
        url: "https://www.espn.com/nfl/story/_/id/a0",
        imageUrl: null,
        summary: ""
      }),
      headline({
        id: "dup",
        url: "https://www.espn.com/nfl/story/_/id/dup-1",
        summary: "",
        title: "Story One"
      }),
      headline({
        id: "b",
        url: "https://www.espn.com/nfl/story/_/id/b",
        summary: "",
        title: "Story Two"
      }),
      headline({
        id: "dup",
        url: "https://www.espn.com/nfl/story/_/id/dup-2",
        summary: "",
        title: "Story Three Distinct"
      }),
      headline({
        id: "d",
        url: "https://www.espn.com/nfl/story/_/id/d",
        summary: "",
        title: "Story Four"
      })
    ];
    const html = renderToString(
      createElement(NewsBand, {
        groups: [{ competitionKey: "nfl", competitionLabel: "NFL", headlines: items }],
        followedPairs: new Set<string>()
      })
    );
    // item0: no imageUrl/no summary, feedRank-0 bonus alone = weight 2 (< BIG_STORY_WEIGHT 4) →
    // never becomes `feature`. items 1-4: default imageUrl (truthy) from headline(), no summary,
    // feedRank!=0 = weight 2 each, tied with item0 → stable sort keeps insertion order.
    // MAJORS_CAP=2 picks the first two image-bearing items in that order: item1 ("dup") + item2
    // ("b"). item3 shares item1's id ("dup") but has a DIFFERENT url — before the fix, id-keyed
    // majorIds/mosaicIds wrongly re-admits item3 as a THIRD major (3 occurrences); after the
    // url-keyed fix, exactly 2.
    const majorCount = html.split("sp-newsband__art--major").length - 1;
    expect(majorCount).toBe(2);
    expect(html).toContain("Story Three Distinct");
  });
});
