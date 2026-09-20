import { afterEach, describe, expect, it } from "vitest";

import {
  fetchWebResource,
  setWebFetchForTests,
  setWebHostResolverForTests
} from "@moss/web-research";

afterEach(() => {
  setWebFetchForTests(undefined);
  setWebHostResolverForTests(undefined);
});

describe("web research fetch implementation", () => {
  it("uses the per-call fetch implementation before the shared test hook", async () => {
    const calls: string[] = [];
    setWebHostResolverForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
    setWebFetchForTests(async () => {
      throw new Error("shared test transport should not run");
    });

    const result = await fetchWebResource("https://example.com/feed.xml", {
      fetchImpl: async (input) => {
        calls.push(input instanceof URL ? input.href : String(input));
        return new Response("<rss />", {
          status: 200,
          headers: { "content-type": "application/rss+xml" }
        });
      }
    });

    expect(result).toMatchObject({ ok: true, status: 200, body: "<rss />" });
    expect(calls).toEqual(["https://example.com/feed.xml"]);
  });
});
