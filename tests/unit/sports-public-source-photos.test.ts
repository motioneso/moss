import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VaultContextRunner } from "@moss/vault";
import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import { SportsPhotoStore } from "../../packages/sports/src/source/photo-store.js";
import {
  actor,
  REFRESH_DEADLINE_MS,
  runtimeSource,
  success,
  makeReader,
  PhotoStoreDouble,
  permitInitialRequest
} from "./sports-public-source-fixtures.js";

describe("the photo pass (#2237)", () => {
  const feedSource = () =>
    runtimeSource({
      id: "feed",
      recipe: null,
      feedUrl: "https://feeds.publisher.example/sports.xml",
      hosts: ["feeds.publisher.example"]
    });

  function feedBody(items: string): string {
    return `<rss><channel>${items}</channel></rss>`;
  }

  it("uses the feed's own media tag and serves the photo from our own address", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image" width="1200"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/story.jpg"]);
    expect(result.headlines[0]?.imageUrl).toBe(
      `/api/sports/headlines/${encodeURIComponent(result.headlines[0]!.id)}/photo`
    );
    expect(result.headlines[0]?.imageWidth).toBe(1280);
    // Only the feed itself was fetched: a usable feed photo makes the article page unnecessary.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("falls back to the article page's share image when the feed has no photo", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/share.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/share.jpg"]);
    expect(result.headlines[0]?.imageUrl).not.toBeNull();
  });

  it("ignores a photo hosted somewhere unrelated to the publisher", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
              `<media:content url="https://tracker.elsewhere.test/pixel.jpg" medium="image"/></item>`
          ),
          "text/plain"
        );
      }
      return success(url, `<html><head></head></html>`, "text/html");
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(photos.stored).toEqual([]);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("opens no article page when under three seconds of the refresh budget remain", async () => {
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    let pageFetches = 0;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        // The feed itself was slow: 9.5 seconds of the twelve-second budget are already gone.
        clock += 9_500;
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      pageFetches += 1;
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/s.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });

    const result = await reader.refresh(actor);

    expect(pageFetches).toBe(0);
    expect(photos.stored).toEqual([]);
    // The story is still returned; only its photo is missing.
    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("never gives a download more time than the refresh has left, and skips it once time is up", async () => {
    const item =
      `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
      `<media:content url="https://publisher.example/story.jpg" medium="image" width="1200"/></item>`;

    async function budgetAfterFeedDelay(delayMs: number): Promise<(number | undefined)[]> {
      let clock = Date.parse("2026-09-04T10:00:00.000Z");
      const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
        if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
        clock += delayMs;
        return success(url, feedBody(item), "text/plain");
      });
      const photos = new PhotoStoreDouble();
      const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });
      await reader.refresh(actor);
      return photos.budgets;
    }

    // Plenty of time left: the download is capped at the store's own five-second limit.
    expect(await budgetAfterFeedDelay(500)).toEqual([5_000]);
    // Four seconds left, one above the safety margin: the download gets exactly that.
    expect(await budgetAfterFeedDelay(8_000)).toEqual([4_000]);
    // Inside the safety margin: no download is started at all.
    expect(await budgetAfterFeedDelay(11_600)).toEqual([]);
    // Past the deadline: still nothing.
    expect(await budgetAfterFeedDelay(12_500)).toEqual([]);
  });

  it("stops asking the photo store anything once the deadline has passed", async () => {
    const items = Array.from(
      { length: 5 },
      (_unused, index) =>
        `<item><guid>feed-${index}</guid><title>Story ${index}</title>` +
        `<link>https://publisher.example/story-${index}</link>` +
        `<media:content url="https://publisher.example/${index}.jpg" medium="image" width="1200"/></item>`
    ).join("");
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      clock += 12_500;
      return success(url, feedBody(items), "text/plain");
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos, now: () => clock });

    const result = await reader.refresh(actor);

    expect(photos.attempts).toBe(0);
    expect(result.headlines).toHaveLength(5);
  });

  it("finishes the refresh inside its deadline even when every photo download hangs", async () => {
    const items = Array.from(
      { length: 6 },
      (_unused, index) =>
        `<item><guid>feed-${index}</guid><title>Story ${index}</title>` +
        `<link>https://publisher.example/story-${index}</link>` +
        `<media:content url="https://publisher.example/${index}.jpg" medium="image" width="1200"/></item>`
    ).join("");
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const started = clock;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(url, feedBody(items), "text/plain");
    });

    const baseDir = await mkdtemp(join(tmpdir(), "sports-photos-reader-"));
    try {
      let downloads = 0;
      // The host accepts the request and then says nothing at all: this promise never settles on
      // its own, so only the store's own time limit can end the call.
      const photos = new SportsPhotoStore({
        vault: new VaultContextRunner(baseDir),
        fetchBytes: () => {
          downloads += 1;
          return new Promise(() => undefined);
        },
        now: () => new Date(clock),
        // Waiting is simulated: the clock jumps forward by exactly as long as the store was
        // prepared to wait, so the test proves the limit without really sitting there.
        delay: async (ms) => {
          clock += ms;
        }
      });
      const { reader } = makeReader([feedSource()], fetch, {
        photos: photos as unknown as PhotoStoreDouble,
        now: () => clock
      });

      const result = await reader.refresh(actor);

      expect(clock - started).toBeLessThanOrEqual(REFRESH_DEADLINE_MS);
      // It gave up on the hung host and moved on, rather than trying all six or hanging on one.
      expect(downloads).toBeGreaterThan(0);
      expect(downloads).toBeLessThan(6);
      expect(result.headlines).toHaveLength(6);
      expect(result.headlines.every((headline) => headline.imageUrl === null)).toBe(true);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  });

  it("still returns every source's headlines when other sources have slow photo work", async () => {
    const slow = ["s1", "s2", "s3", "s4"];
    const sources = [...slow, "s5"].map((id) =>
      runtimeSource({
        id,
        recipe: null,
        feedUrl: `https://feeds.publisher.example/${id}.xml`,
        hosts: ["feeds.publisher.example"]
      })
    );
    let clock = Date.parse("2026-09-04T10:00:00.000Z");
    const deadlineAt = clock + REFRESH_DEADLINE_MS;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      // A publisher cannot answer after the refresh has run out of time, so a source that only
      // gets its turn late comes back with nothing.
      if (clock >= deadlineAt) return { ok: false, reason: "timeout" };
      const id = url.slice(url.lastIndexOf("/") + 1, -".xml".length);
      return success(
        url,
        feedBody(
          `<item><guid>${id}-1</guid><title>Story ${id}</title>` +
            `<link>https://publisher.example/${id}</link>` +
            `<media:content url="https://publisher.example/${id}.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    // Four seconds of photo work each: enough that four sources exhaust the whole refresh.
    photos.beforeEnsure = (sourceId) => {
      if (slow.includes(sourceId)) clock += 4_000;
    };
    const { reader } = makeReader(sources, fetch, { photos, now: () => clock });

    const result = await reader.refresh(actor);

    expect([...new Set(result.headlines.map((headline) => headline.sourceId))].sort()).toEqual([
      "s1",
      "s2",
      "s3",
      "s4",
      "s5"
    ]);
  });

  it("takes a publisher slot for the photo download, not just for the article page", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://images.publisher.example/story.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    await reader.refresh(actor);

    expect(photos.slotHosts).toEqual(["images.publisher.example"]);
  });

  it("does not download the same broken photo again on the next refresh", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/broken.jpg" medium="image" width="1200"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    photos.alwaysFails = true;
    const { reader } = makeReader([feedSource()], fetch, { photos });

    await reader.refresh(actor);
    const second = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/broken.jpg"]);
    expect(second.headlines[0]?.imageUrl).toBeNull();
  });

  it("fetches at most six article pages for one source in a refresh", async () => {
    const items = Array.from(
      { length: 9 },
      (_unused, index) =>
        `<item><guid>feed-${index}</guid><title>Story ${index}</title>` +
        `<link>https://publisher.example/story-${index}</link></item>`
    ).join("");
    let pageFetches = 0;
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) return success(url, feedBody(items), "text/plain");
      pageFetches += 1;
      return success(
        url,
        `<html><head><meta property="og:image" content="https://publisher.example/s.jpg"></head></html>`,
        "text/html"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(pageFetches).toBe(6);
    expect(result.headlines).toHaveLength(9);
  });

  it("still returns headlines when every photo attempt fails", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      if (url.endsWith("sports.xml")) {
        return success(
          url,
          feedBody(
            `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link></item>`
          ),
          "text/plain"
        );
      }
      throw new Error("the publisher hung up");
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const result = await reader.refresh(actor);

    expect(result.headlines).toHaveLength(1);
    expect(result.headlines[0]?.imageUrl).toBeNull();
  });

  it("tells the store which copies this refresh still uses", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], fetch, { photos });

    const { headlines } = await reader.refresh(actor);

    expect(photos.swept).not.toBeNull();
    expect([...(photos.swept ?? [])]).toEqual(["key-1"]);
    expect([...photos.links.keys()]).toEqual([`user-a ${headlines[0]!.id}`]);
  });

  it("leaves every story without a photo when no store is wired in", async () => {
    const fetch = vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        feedBody(
          `<item><guid>feed-1</guid><title>Story</title><link>https://publisher.example/story</link>` +
            `<media:content url="https://publisher.example/story.jpg" medium="image"/></item>`
        ),
        "text/plain"
      );
    });
    const { reader } = makeReader([feedSource()], fetch);

    const result = await reader.refresh(actor);

    expect(result.headlines[0]?.imageUrl).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
