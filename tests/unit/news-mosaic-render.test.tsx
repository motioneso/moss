import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NewsHeadline } from "@moss/shared";

import { NewsMosaic, type MosaicPlan } from "../../packages/news/src/web/news-mosaic.js";

// #1185: image/no-image markup regression. Two separate renders (one card each) so the
// img-absence assertion for the no-photo card can't accidentally pass by matching the photo
// card's markup in the same string. Deliberately no assertions on title/summary copy — the spec
// wants structural classes covered, not incidental feed text.
function headline(overrides: Partial<NewsHeadline> = {}): NewsHeadline {
  return {
    id: "h-1",
    title: "A headline",
    url: "https://example.com/1",
    publishedAt: "2026-07-19T12:00:00.000Z",
    imageUrl: null,
    faviconUrl: null,
    summary: "A summary.",
    sourceKey: "bbc",
    sourceLabel: "BBC News",
    topicKey: null,
    topicLabel: null,
    ...overrides
  };
}

function planFor(headlines: readonly NewsHeadline[]): MosaicPlan {
  return { feature: null, mosaic: headlines, majorIds: new Set(), briefs: [] };
}

describe("NewsMosaic card markup (#1185)", () => {
  it("photo standard card renders the image and no textonly modifier", () => {
    const photo = headline({ id: "h-photo", imageUrl: "https://img.example/1.jpg" });
    const html = renderToString(createElement(NewsMosaic, { plan: planFor([photo]) }));

    expect(html).toContain("nw-mosaic__img");
    expect(html).toContain("nw-mosaic__artkicker");
    expect(html).not.toContain("nw-mosaic__art--textonly");
  });

  it("no-photo standard card gets the textonly modifier and renders no <img>", () => {
    const textOnly = headline({ id: "h-text", imageUrl: null });
    const html = renderToString(createElement(NewsMosaic, { plan: planFor([textOnly]) }));

    expect(html).toContain("nw-mosaic__art--textonly");
    expect(html).toContain("nw-mosaic__artkicker");
    expect(html).not.toContain("<img");
  });
});
