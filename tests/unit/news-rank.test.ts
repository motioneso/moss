import { describe, expect, it } from "vitest";

import type { DataContextDb } from "@moss/db";

import type { NewsCandidate } from "../../packages/news/src/compilation/candidates.js";
import { orderRanked, rankCandidates } from "../../packages/news/src/compilation/rank.js";

const db = {} as DataContextDb;

function candidate(overrides: Partial<NewsCandidate> = {}): NewsCandidate {
  return {
    id: "c1",
    publisher: "Example",
    canonicalDomain: "example.com",
    headline: "External headline",
    url: "https://example.com/private-prompt-marker",
    publishedAt: "2026-07-11T11:00:00.000Z",
    excerpt: "External excerpt",
    imageUrl: null,
    origin: "topic_search",
    matchedTopics: ["AI"],
    ...overrides
  };
}

describe("rankCandidates", () => {
  it("drops unknown, duplicate, and ineligible IDs and clamps relevance", async () => {
    const result = await rankCandidates(
      db,
      {
        ai: {
          fingerprint: async () => "fp",
          generateJson: async () => ({
            ok: true,
            object: {
              rankings: [
                { id: "unknown", relevance: 100, eligible: true },
                { id: "c1", relevance: 500, eligible: true },
                { id: "c1", relevance: 1, eligible: true },
                { id: "c2", relevance: 70, eligible: false }
              ]
            }
          })
        }
      },
      {
        candidates: [candidate(), candidate({ id: "c2", url: "https://example.com/two" })],
        topics: []
      }
    );
    expect(result).toMatchObject({
      ok: true,
      ranked: [{ id: "c1", relevance: 100 }]
    });
  });

  it("preserves provider/configuration and malformed-output failure categories", async () => {
    for (const [generated, error] of [
      [{ ok: false as const, error: "provider_error" as const }, "provider_error"],
      [{ ok: false as const, error: "needs_config" as const }, "needs_config"],
      [{ ok: true as const, object: { nope: [] } }, "malformed_output"]
    ] as const) {
      await expect(
        rankCandidates(
          db,
          {
            ai: {
              fingerprint: async () => "fp",
              generateJson: async () => generated
            }
          },
          { candidates: [candidate()], topics: [] }
        )
      ).resolves.toEqual({ ok: false, error });
    }
  });

  it("puts headlines in an untrusted data block without article URLs", async () => {
    let prompt = "";
    let schema: Record<string, unknown> = {};
    await rankCandidates(
      db,
      {
        ai: {
          fingerprint: async () => "fp",
          generateJson: async (_db, input) => {
            prompt = input.prompt;
            schema = input.schema;
            return { ok: true, object: { rankings: [] } };
          }
        }
      },
      {
        candidates: [candidate()],
        topics: [{ label: "AI", guidance: "Primary sources" }]
      }
    );
    expect(prompt).toContain("UNTRUSTED CANDIDATE DATA");
    expect(prompt).toContain("External headline");
    expect(prompt).not.toContain("private-prompt-marker");
    expect(schema).toMatchObject({ additionalProperties: false });
  });
});

describe("orderRanked", () => {
  it("orders by relevance, preference, recency, then URL", () => {
    const ranked = [
      {
        ...candidate({ id: "url-b", url: "https://example.com/b" }),
        relevance: 50,
        preferredBoost: false
      },
      {
        ...candidate({
          id: "recent",
          url: "https://example.com/c",
          publishedAt: "2026-07-11T12:00:00Z"
        }),
        relevance: 50,
        preferredBoost: false
      },
      {
        ...candidate({ id: "preferred", url: "https://example.com/d", origin: "preferred_source" }),
        relevance: 50,
        preferredBoost: true
      },
      {
        ...candidate({ id: "url-a", url: "https://example.com/a" }),
        relevance: 50,
        preferredBoost: false
      },
      {
        ...candidate({ id: "highest", url: "https://example.com/e" }),
        relevance: 90,
        preferredBoost: false
      }
    ];
    expect(orderRanked(ranked).map((item) => item.id)).toEqual([
      "highest",
      "preferred",
      "recent",
      "url-a",
      "url-b"
    ]);
  });
});
