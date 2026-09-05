import { describe, expect, it, vi } from "vitest";

import type { SportsSafeFetchPort } from "../../packages/sports/src/source/discovery.js";
import type * as PhotoStorageModule from "../../packages/sports/src/source/photo-storage.js";

import {
  PhotoStoreDouble,
  actor,
  makeReader,
  permitInitialRequest,
  runtimeSource,
  success
} from "./sports-public-source-reader-helpers.js";

/**
 * #2237 review 1: the photo outcome the refresh records for a source must describe photos that
 * were actually downloaded and attached to the returned stories, not candidate addresses found
 * in the feed. A candidate whose download is rejected is a miss, so a broken image can never
 * report "working" or clear the miss streak that decision 6c counts.
 */

const recordSportsPhotoOutcome = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../../packages/sports/src/source/photo-storage.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PhotoStorageModule>();
  return { ...actual, recordSportsPhotoOutcome };
});

describe("the photo outcome a refresh records (#2237)", () => {
  const feedSource = () =>
    runtimeSource({
      id: "feed",
      recipe: null,
      feedUrl: "https://feeds.publisher.example/sports.xml",
      hosts: ["feeds.publisher.example"]
    });

  const feedWithPhoto = () =>
    vi.fn<SportsSafeFetchPort>(async (url, options) => {
      if (!(await permitInitialRequest(url, options))) return { ok: false, reason: "blocked" };
      return success(
        url,
        `<rss><channel><item><guid>feed-1</guid><title>Story</title>` +
          `<link>https://publisher.example/story</link>` +
          `<media:content url="https://publisher.example/story.jpg" medium="image"/>` +
          `</item></channel></rss>`,
        "text/plain"
      );
    });

  it("records working only once a photo was stored and attached to a returned story", async () => {
    recordSportsPhotoOutcome.mockClear();
    const photos = new PhotoStoreDouble();
    const { reader } = makeReader([feedSource()], feedWithPhoto(), { photos });

    const { headlines } = await reader.refresh(actor);

    expect(headlines[0]?.imageUrl).not.toBeNull();
    expect(recordSportsPhotoOutcome).toHaveBeenCalledTimes(1);
    expect(recordSportsPhotoOutcome).toHaveBeenCalledWith(expect.anything(), "feed", "working");
  });

  it("records none when the feed named a photo but its download was rejected", async () => {
    recordSportsPhotoOutcome.mockClear();
    const photos = new PhotoStoreDouble();
    photos.alwaysFails = true;
    const { reader } = makeReader([feedSource()], feedWithPhoto(), { photos });

    const { headlines } = await reader.refresh(actor);

    expect(photos.stored).toEqual(["https://publisher.example/story.jpg"]);
    expect(headlines).toHaveLength(1);
    expect(headlines[0]?.imageUrl).toBeNull();
    expect(recordSportsPhotoOutcome).toHaveBeenCalledTimes(1);
    expect(recordSportsPhotoOutcome).toHaveBeenCalledWith(expect.anything(), "feed", "none");
  });
});
