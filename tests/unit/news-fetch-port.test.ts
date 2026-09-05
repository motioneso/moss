import { describe, expect, it } from "vitest";

import type {
  NewsFetchOptions,
  NewsFetchPort,
  NewsSafeFetchPort,
  RedditFetchOptions,
  RedditFetchPort
} from "@moss/news";

/**
 * #2282 task 1.5: the options-capable News fetch port must be usable by the shared Reddit reader
 * with no adapter in between, and the existing URL-only port must still satisfy it so current
 * callers and test fakes keep working untouched.
 */
describe("news fetch port with options (#2282 task 1.5)", () => {
  it("is assignable to the Reddit reader's fetch port and hands the reader's options through untouched", async () => {
    const seen: (NewsFetchOptions | undefined)[] = [];
    const port: NewsFetchPort = async (_url, options) => {
      seen.push(options);
      return {
        ok: false,
        reason: "rate_limited",
        status: 429,
        retryAfter: "30",
        detail: "aborted"
      };
    };
    // Compile-time proof: the reader accepts News' port directly.
    const readerPort: RedditFetchPort = port;
    const readerOptions: RedditFetchOptions = {
      allowedHosts: ["www.reddit.com"],
      requestHeaders: { accept: "application/json" },
      userAgent: "jarv1s-news/1.0",
      allowedContentTypes: ["application/json"],
      beforeRequest: () => true,
      maxBytes: 1024,
      rejectOversizedResponses: true,
      skipRobots: true
    };

    const result = await readerPort("https://www.reddit.com/r/news/top.json", readerOptions);

    expect(seen[0]).toBe(readerOptions);
    expect(result).toEqual({
      ok: false,
      reason: "rate_limited",
      status: 429,
      retryAfter: "30",
      detail: "aborted"
    });
  });

  it("a URL-only safe fetch port satisfies the options-capable port", async () => {
    const urlOnly: NewsSafeFetchPort = async (url) => ({
      ok: true,
      status: 200,
      finalUrl: url,
      contentType: null,
      body: "",
      truncated: false
    });
    const port: NewsFetchPort = urlOnly;

    await expect(port("https://example.com/", { skipRobots: true })).resolves.toMatchObject({
      ok: true,
      finalUrl: "https://example.com/"
    });
  });
});
