import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  createRssDatasetAdapter,
  stableIdForUrl,
  toFeedItems
} from "../../packages/news/src/source/rss-source.js";
import { sourceEntry } from "../../packages/news/src/source/catalog.js";

// Real feed captures (2026-07-08) covering the three parser shapes the catalog serves:
// RSS2 + media:thumbnail (BBC), RSS2 + multi-width media:content (Guardian), Atom (Verge).
function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../packages/news/src/source/__fixtures__/${name}`, import.meta.url)),
    "utf8"
  );
}

const bbc = sourceEntry("bbc")!;
const guardian = sourceEntry("guardian")!;
const verge = sourceEntry("verge")!;
const npr = sourceEntry("npr")!;

// Minimal synthetic RSS2 builder for edge cases the real fixtures can't exercise (cap, dedupe,
// hostile hosts) — item bodies are supplied verbatim so tests control every tag.
function rss(itemsXml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Synthetic</title>
${itemsXml}
  </channel>
</rss>`;
}

describe("stableIdForUrl (#897)", () => {
  it("is deterministic and 8 lowercase hex chars (React key + dedupe key)", () => {
    const id = stableIdForUrl("https://example.com/story");
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(stableIdForUrl("https://example.com/story")).toBe(id);
    expect(stableIdForUrl("https://example.com/other")).not.toBe(id);
  });
});

describe("toFeedItems: BBC (RSS2 + CDATA + media:thumbnail)", () => {
  const items = toFeedItems(fixture("bbc-feed.xml"), bbc);

  it("parses every item with sanitized fields", () => {
    expect(items).toHaveLength(4);
    expect(items[0]?.title).toBe(
      "Jackdaw boss warns of winter fuel shortages if gas field not approved"
    );
    // htmlparser2's XML mode decodes &amp; in the <link> text; the query string must survive.
    expect(items[0]?.url).toBe(
      "https://www.bbc.co.uk/news/articles/cdx78n4nkvyo?at_medium=RSS&at_campaign=rss"
    );
    expect(items[0]?.publishedAt).toBe("2026-07-09T05:04:17.000Z");
    expect(items[0]?.summary.length).toBeGreaterThan(0);
  });

  it("keeps thumbnail art because ichef.bbci.co.uk is on the source's allow-list", () => {
    expect(items[0]?.imageUrl).toMatch(/^https:\/\/ichef\.bbci\.co\.uk\//);
  });
});

describe("toFeedItems: Guardian (RSS2 + HTML descriptions + multi-width media:content)", () => {
  const items = toFeedItems(fixture("guardian-feed.xml"), guardian);

  it("parses every item", () => {
    expect(items).toHaveLength(4);
    expect(items[0]?.title).toBe(
      "Graham Platner debacle puts Democrats in grave danger of blowing it in the midterms"
    );
  });

  it("keeps the WIDEST media:content rendition (Guardian emits 140/460/700)", () => {
    // The 140px thumb arrives first in document order; a naive first-wins would ship a
    // postage stamp into the double-column feature slot.
    expect(items[0]?.imageUrl).toContain("width=700");
    expect(items[0]?.imageUrl).toMatch(/^https:\/\/i\.guim\.co\.uk\//);
  });

  it("strips the real HTML (<p>, <a href>) Guardian puts in descriptions", () => {
    for (const item of items) {
      expect(item.summary).not.toMatch(/[<>]/);
      expect(item.summary).not.toContain("href");
    }
    expect(items[0]?.summary.length).toBeGreaterThan(0);
  });
});

describe("toFeedItems: Verge (Atom, whitespace-spread root, link@href)", () => {
  const items = toFeedItems(fixture("verge-feed.xml"), verge);

  it("parses Atom entries with the rel=alternate link and an ISO publishedAt", () => {
    expect(items).toHaveLength(3);
    expect(items[0]?.url).toBe(
      "https://www.theverge.com/tech/963138/meta-smart-glasses-recording-super-sensing-ai"
    );
    // <updated>/<published> carry the same instant on this entry; -04:00 must normalize to Z.
    expect(items[0]?.publishedAt).toBe("2026-07-08T22:37:25.000Z");
    expect(items[0]?.title.length).toBeGreaterThan(0);
    expect(items[0]?.summary.length).toBeGreaterThan(0);
  });

  it("has no media tags, so artwork comes from the first <img> in the story body", () => {
    for (const item of items) expect(item.imageUrl).toMatch(/^https:\/\/platform\.theverge\.com\//);
  });
});

describe("toFeedItems: NPR (RSS2, no media tags, image comes from the story body)", () => {
  const items = toFeedItems(fixture("npr-feed.xml"), npr);

  it("parses every item", () => {
    expect(items).toHaveLength(5);
  });

  it("picks the first <img> in content:encoded when there is no media tag", () => {
    expect(items[0]?.title).toBe("Congress returns to a packed agenda this fall");
    expect(items[0]?.imageUrl).toMatch(/^https:\/\/npr\.brightspotcdn\.com\//);
  });

  it("falls back to the first <img> in the description when there is no content:encoded", () => {
    expect(items[1]?.title).toBe("A new exhibit traces the history of jazz in New Orleans");
    expect(items[1]?.imageUrl).toMatch(/^https:\/\/npr\.brightspotcdn\.com\//);
  });

  it("drops a body image on a host that isn't on the source's allow-list", () => {
    expect(items[2]?.title).toBe("Tracker ad served through a compromised syndication partner");
    expect(items[2]?.imageUrl).toBeNull();
  });

  it("yields null when the story has no image anywhere", () => {
    expect(items[3]?.title).toBe("Weather segment with no accompanying artwork");
    expect(items[3]?.imageUrl).toBeNull();
  });

  it("prefers a real media tag over an <img> in the story body", () => {
    expect(items[4]?.title).toBe("Media tag still wins over the body image");
    expect(items[4]?.imageUrl).toBe("https://media.npr.org/assets/img/2026/09/04/thumb.jpg");
  });
});

describe("toFeedItems: caps and drops (#897 spec 'Sanitization / security')", () => {
  it("caps a feed at 30 items", () => {
    const many = Array.from(
      { length: 35 },
      (_, i) => `    <item>
      <title>Story ${i}</title>
      <link>https://example.com/story-${i}</link>
    </item>`
    ).join("\n");
    // Any catalog source works here: the cap is per-feed, not per-source.
    expect(toFeedItems(rss(many), bbc)).toHaveLength(30);
  });

  it("dedupes items that share a URL (same story in two channel slots)", () => {
    const xml = rss(`    <item>
      <title>First copy</title>
      <link>https://example.com/dup</link>
    </item>
    <item>
      <title>Second copy</title>
      <link>https://example.com/dup</link>
    </item>`);
    const items = toFeedItems(xml, bbc);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe("First copy");
  });

  it("drops an item whose link is not http(s) — a feed can't smuggle a javascript: href", () => {
    const xml = rss(`    <item>
      <title>Evil</title>
      <link>javascript:alert(1)</link>
    </item>
    <item>
      <title>Fine</title>
      <link>https://example.com/ok</link>
    </item>`);
    const items = toFeedItems(xml, bbc);
    expect(items.map((i) => i.title)).toEqual(["Fine"]);
  });

  it("drops an item whose title sanitizes to empty (nothing to render)", () => {
    const xml = rss(`    <item>
      <title>&lt;b&gt;&lt;/b&gt;</title>
      <link>https://example.com/no-title</link>
    </item>`);
    expect(toFeedItems(xml, bbc)).toHaveLength(0);
  });

  it("nulls artwork on a host outside the source's allow-list (defense in front of CSP img-src)", () => {
    const xml = rss(`    <item>
      <title>Off-host art</title>
      <link>https://example.com/art</link>
      <media:thumbnail url="https://evil.example/track.png" width="240"/>
    </item>`);
    expect(toFeedItems(xml, bbc)[0]?.imageUrl).toBeNull();
  });

  it("nulls plain-http artwork even on an allow-listed host (https only)", () => {
    const xml = rss(`    <item>
      <title>Insecure art</title>
      <link>https://example.com/art2</link>
      <media:thumbnail url="http://ichef.bbci.co.uk/img.png" width="240"/>
    </item>`);
    expect(toFeedItems(xml, bbc)[0]?.imageUrl).toBeNull();
  });

  it("ignores a non-image enclosure (podcasts must not become artwork)", () => {
    const xml = rss(`    <item>
      <title>Podcast</title>
      <link>https://example.com/pod</link>
      <enclosure url="https://ichef.bbci.co.uk/audio.mp3" type="audio/mpeg" length="1"/>
    </item>`);
    expect(toFeedItems(xml, bbc)[0]?.imageUrl).toBeNull();
  });
});

describe("createRssDatasetAdapter (#897)", () => {
  const adapter = createRssDatasetAdapter();
  const okFetch = (body: string): typeof fetch =>
    (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it("serves the declared 'feed' dataset from the fetched XML", async () => {
    const items = (await adapter.fetchDataset(
      "feed",
      { sourceKey: "bbc", topicKey: null },
      { fetchFn: okFetch(fixture("bbc-feed.xml")) }
    )) as { title: string }[];
    expect(items).toHaveLength(4);
  });

  it("throws on an undeclared dataset key (wiring bug, must not degrade silently)", async () => {
    // Mirrors the production DatasetClient contract — the sports #857 500 shipped because a
    // test stub swallowed an undeclared key into the fallback.
    await expect(
      adapter.fetchDataset(
        "headlines",
        { sourceKey: "bbc", topicKey: null },
        {
          fetchFn: okFetch("")
        }
      )
    ).rejects.toThrow(/unknown dataset/i);
  });

  it("throws on an unknown sourceKey (params can't steer the fetch off-catalog)", async () => {
    await expect(
      adapter.fetchDataset(
        "feed",
        { sourceKey: "not-a-source", topicKey: null },
        {
          fetchFn: okFetch("")
        }
      )
    ).rejects.toThrow(/unknown source/i);
  });

  it("returns [] (degrade-empty) for a topic the source doesn't map", async () => {
    // BBC has no politics feed; the service normally never plans this fetch, but a caller bug
    // must yield an empty feed, not a 500 for the whole overview.
    const items = await adapter.fetchDataset(
      "feed",
      { sourceKey: "bbc", topicKey: "politics" },
      {
        fetchFn: okFetch(fixture("bbc-feed.xml"))
      }
    );
    expect(items).toEqual([]);
  });

  it("throws a typed error on non-200 (dataset runtime degrades it)", async () => {
    const failFetch = (async () =>
      new Response("nope", { status: 503 })) as unknown as typeof fetch;
    await expect(
      adapter.fetchDataset("feed", { sourceKey: "bbc", topicKey: null }, { fetchFn: failFetch })
    ).rejects.toThrow(/503/);
  });
});
