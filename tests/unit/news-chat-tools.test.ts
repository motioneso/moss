import { dataContextBrand, type DataContextDb } from "@moss/db";
import { describe, expect, it } from "vitest";

import {
  configureNewsChatTools,
  newsCredentialedSourceStatusExecute
} from "../../packages/news/src/chat-tools.js";
import type { NewsPersonalizationStore } from "../../packages/news/src/personalization-routes.js";

const scopedDb = { db: {} as never, [dataContextBrand]: true } satisfies DataContextDb;
const context = { actorUserId: "owner-a", requestId: "request-a", chatSessionId: "chat-a" };

describe("news.credentialedSourceStatus (#2006)", () => {
  it("accepts empty input and returns only safe source status and fixed guidance", async () => {
    const source = {
      id: "source-a",
      label: "Example Wire",
      canonicalDomain: "wire.example.com",
      homepageUrl: "https://wire.example.com",
      feedUrl: null,
      retrievalMethod: "scrape" as const,
      validationStatus: "approved" as const,
      healthStatus: "authentication_failed" as const,
      createdAt: "2026-08-28T00:00:00.000Z"
    };
    configureNewsChatTools({
      previews: {} as never,
      discovery: {} as never,
      availability: {} as never,
      boss: null,
      repository: {
        listCustomSources: async () => [source]
      } as unknown as NewsPersonalizationStore,
      credentials: {
        readStatuses: async () => [
          {
            sourceId: source.id,
            connectionId: "example-wire",
            status: "configured" as const,
            lastValidatedAt: new Date("2026-08-28T00:00:00.000Z"),
            revokedAt: null
          }
        ]
      }
    });

    const result = await newsCredentialedSourceStatusExecute(scopedDb, {}, context);

    expect(result).toEqual({
      data: {
        sources: [
          {
            sourceId: "source-a",
            label: "Example Wire",
            domain: "wire.example.com",
            healthStatus: "authentication_failed",
            credentialStatus: "configured",
            guidance: "Authentication failed. Replace the key in News settings."
          }
        ]
      }
    });
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    expect(JSON.stringify(result)).not.toContain("headers");
  });
});
