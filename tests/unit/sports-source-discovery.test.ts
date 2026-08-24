import { describe, expect, it, vi } from "vitest";

import type { DataContextDb } from "@moss/db";
import type { NewsAiPort, NewsSafeFetchPort } from "@moss/news";

import {
  resolveSportsSourceInput,
  type SportsPolicyVerdictRepo
} from "../../packages/sports/src/source/discovery.js";

const db = {} as DataContextDb;
const feed = `<rss><channel><item><title>A consequential sports headline today</title><link>https://one.example/story</link><pubDate>Fri, 11 Jul 2026 12:00:00 GMT</pubDate></item></channel></rss>`;

function ai(allowed = true): NewsAiPort {
  return {
    fingerprint: async () => "fp",
    generateJson: async () => ({
      ok: true,
      object: { allowed, category: "news_publisher" }
    })
  };
}

function repo(): SportsPolicyVerdictRepo {
  return {
    readPolicyVerdict: vi.fn(async () => null),
    upsertPolicyVerdict: vi.fn(async () => {})
  };
}

function fetchMap(
  entries: Record<string, { body: string; contentType?: string }>
): NewsSafeFetchPort {
  return vi.fn(async (url: string) => {
    const entry = entries[url];
    return entry
      ? {
          ok: true as const,
          status: 200,
          finalUrl: url,
          contentType: entry.contentType ?? "text/html",
          body: entry.body,
          truncated: false
        }
      : { ok: false as const, reason: "network" as const };
  });
}

describe("resolveSportsSourceInput", () => {
  it("resolves a direct feed URL to a single feed candidate", async () => {
    const result = await resolveSportsSourceInput(
      db,
      {
        fetch: fetchMap({
          "https://one.example/feed.xml": { body: feed, contentType: "application/rss+xml" }
        }),
        ai: ai(),
        repo: repo()
      },
      { rawUrl: "https://one.example/feed.xml" }
    );
    expect(result).toMatchObject({
      status: "ok",
      candidate: {
        canonicalDomain: "one.example",
        feedUrl: "https://one.example/feed.xml",
        retrievalMethod: "feed",
        sampleCount: 1,
        validationFingerprint: "fp",
        recipe: null,
        recipeFingerprint: null,
        confirmedFetchHosts: ["one.example"]
      }
    });
  });

  it("rejects a non-HTTPS URL without making a network request", async () => {
    const fetch = fetchMap({});
    await expect(
      resolveSportsSourceInput(
        db,
        { fetch, ai: ai(), repo: repo() },
        { rawUrl: "http://one.example" }
      )
    ).resolves.toEqual({ status: "rejected", reason: "not_https" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unreachable target", async () => {
    await expect(
      resolveSportsSourceInput(
        db,
        { fetch: fetchMap({}), ai: ai(), repo: repo() },
        { rawUrl: "https://unreachable.example" }
      )
    ).resolves.toEqual({ status: "rejected", reason: "unreachable" });
  });

  // A broken implementation that skipped redirect revalidation and trusted the requested domain
  // instead of fetched.finalUrl would let a spoofed domain through as status "ok" here.
  it("rejects a redirect that changes publisher identity", async () => {
    const redirectsAway: NewsSafeFetchPort = async () => ({
      ok: true,
      status: 200,
      finalUrl: "https://evil.test/",
      contentType: "text/html",
      body: `<a href="/story">A sufficiently important headline today</a>`,
      truncated: false
    });
    await expect(
      resolveSportsSourceInput(
        db,
        { fetch: redirectsAway, ai: ai(), repo: repo() },
        { rawUrl: "https://one.example" }
      )
    ).resolves.toEqual({ status: "rejected", reason: "policy" });
  });

  it("rejects when the AI policy check is unavailable", async () => {
    const noAi: NewsAiPort = {
      fingerprint: async () => null,
      generateJson: async () => ({ ok: false, error: "needs_config" })
    };
    await expect(
      resolveSportsSourceInput(
        db,
        {
          fetch: fetchMap({
            "https://one.example/": {
              body: `<title>One</title><a href="/story">A sufficiently important headline today</a>`
            }
          }),
          ai: noAi,
          repo: repo()
        },
        { rawUrl: "https://one.example" }
      )
    ).resolves.toEqual({ status: "unavailable" });
  });
});
