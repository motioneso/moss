import { describe, expect, it, vi } from "vitest";

import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import { makeReader, success } from "./sports-public-source-reader-helpers.js";

const WPBL_FEED = "https://www.womensprobaseballleague.com/feed/";

const WPBL_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Women's Pro Baseball League</title>
    <link>https://www.womensprobaseballleague.com/</link>
    <item>
      <title>Boston opens the season at home</title>
      <link>https://www.womensprobaseballleague.com/boston-opener</link>
      <guid>https://www.womensprobaseballleague.com/boston-opener</guid>
      <pubDate>Wed, 23 Sep 2026 14:00:00 GMT</pubDate>
    </item>
    <item>
      <title>New York signs two pitchers</title>
      <link>https://www.womensprobaseballleague.com/new-york-signings</link>
      <guid>https://www.womensprobaseballleague.com/new-york-signings</guid>
    </item>
  </channel>
</rss>`;

describe("refreshCatalogFeeds (#2661 news-only competitions)", () => {
  it("reads a catalog feed and files its stories under the competition", async () => {
    const fetch = vi.fn(async (url: string, _options?: Parameters<SportsSafeFetchPort>[1]) =>
      success(url, WPBL_RSS, "application/rss+xml")
    );
    const { reader } = makeReader([], fetch as SportsSafeFetchPort, { now: () => 1_000_000 });

    const headlines = await reader.refreshCatalogFeeds(["wpbl"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(WPBL_FEED);
    expect(fetch.mock.calls[0]?.[1]?.allowedHosts).toEqual(["www.womensprobaseballleague.com"]);
    expect(headlines).toHaveLength(2);
    for (const headline of headlines) {
      expect(headline.origin).toBe("custom");
      expect(headline.sourceId).toBe("catalog:wpbl");
      expect(headline.competitionKey).toBe("wpbl");
      expect(headline.competitionLabel).toBe("Women's Pro Baseball League");
      expect(headline.sportKey).toBe("baseball");
      expect(headline.publisherDomain).toBe("www.womensprobaseballleague.com");
      expect(headline.publishedAt).toBeTruthy();
      // No roster yet, so nothing is team-scoped.
      expect(headline.teamKeys).toEqual([]);
    }
    expect(headlines.map((h) => h.title)).toEqual([
      "Boston opens the season at home",
      "New York signs two pitchers"
    ]);
  });

  it("fetches nothing for competitions without a catalog feed", async () => {
    const fetch = vi.fn(async (url: string) => success(url, WPBL_RSS, "application/rss+xml"));
    const { reader } = makeReader([], fetch as SportsSafeFetchPort, { now: () => 1_000_000 });
    expect(await reader.refreshCatalogFeeds(["nba", "unknown.league"])).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("serves a second call from the cache", async () => {
    const fetch = vi.fn(async (url: string) => success(url, WPBL_RSS, "application/rss+xml"));
    const { reader } = makeReader([], fetch as SportsSafeFetchPort, { now: () => 1_000_000 });
    await reader.refreshCatalogFeeds(["wpbl"]);
    await reader.refreshCatalogFeeds(["wpbl"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns no stories rather than throwing when the feed fails", async () => {
    const failing = vi.fn(async () => ({ ok: false, reason: "network" }) as const);
    const { reader } = makeReader([], failing as unknown as SportsSafeFetchPort, {
      now: () => 1_000_000
    });
    expect(await reader.refreshCatalogFeeds(["wpbl"])).toEqual([]);

    const unsupported = vi.fn(async (url: string) =>
      success(url, "<html>not a feed</html>", "text/html")
    );
    const other = makeReader([], unsupported as SportsSafeFetchPort, { now: () => 1_000_000 });
    expect(await other.reader.refreshCatalogFeeds(["wpbl"])).toEqual([]);
  });
});
