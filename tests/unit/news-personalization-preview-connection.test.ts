// #2008 — the rule that decides whether News asks somebody for a secret.
//
// A key box must appear only when the preview found exactly one candidate AND that candidate's
// homepage is unmistakably a reviewed publisher's own address. Every other shape of preview must
// come back byte for byte as it does today.
//
// The offer tests below drive the REAL preview route, registered by registerNewsRoutes with the
// real reviewed-publisher list, and read the answer off the wire. That is deliberate: an earlier
// version of this file rebuilt the offer in a local helper, so deleting the "exactly one
// candidate" guard in the handler left the suite green. Nothing here can pass without the
// handler and the composition wiring in routes.ts both being right.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { DatasetClient, DatasetEnvelope } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import type {
  NewsCustomSourceDto,
  NewsCustomTopicDto,
  NewsPublisherConnectionOfferDto,
  NewsRefreshStateDto,
  NewsSourceExclusionDto
} from "@moss/shared";

import type { NewsSafeFetchPort } from "../../packages/news/src/discovery/ports.js";
import type { NewsPersonalizationStore } from "../../packages/news/src/personalization-routes.js";
import { registerNewsRoutes } from "../../packages/news/src/routes.js";
import { createRegistryNewsPublisherConnectionPort } from "../../packages/news/src/source/publisher-connection-registry.js";
import { createEmptyNewsPublisherConnectionPort } from "../../packages/news/src/publisher-connection-port.js";
import {
  newsApiConnection,
  NEWSAPI_CONNECTION_ID
} from "../../packages/news/src/source/newsapi-connection.js";

const port = createRegistryNewsPublisherConnectionPort();

describe("reviewed publisher lookup", () => {
  it("describes the one reviewed connection with its display fields", () => {
    const descriptor = port.describe(NEWSAPI_CONNECTION_ID);
    expect(descriptor).toBeDefined();
    expect(descriptor?.publisherName).toBe(newsApiConnection.publisherName);
    expect(descriptor?.host).toBe("newsapi.org");
    expect(descriptor?.accessSummary).toBe(newsApiConnection.accessSummary);
    expect(descriptor?.termsUrl).toBe(newsApiConnection.termsUrl);
    // A credentialed publisher has no feed to poll; its items come from the pinned endpoint.
    expect(descriptor?.feedUrl).toBeNull();
    expect(descriptor?.retrievalMethod).toBe("scrape");
  });

  it("never reveals anything about the outgoing request", () => {
    const descriptor = port.describe(NEWSAPI_CONNECTION_ID);
    const serialized = JSON.stringify(descriptor);
    // Leaking the header name or the endpoint path would tell an attacker exactly how to
    // replay a stolen key, and neither is anything the user needs in order to decide.
    expect(serialized).not.toContain(newsApiConnection.apiKeyHeader);
    expect(serialized).not.toContain(newsApiConnection.endpoint);
    expect(serialized).not.toContain("/v2/");
    // The connection id happens to read like the dataset it serves. That is a stored
    // identifier, not the request path, so it is allowed out.
  });

  it("does not describe an unknown connection", () => {
    expect(port.describe("not-a-connection")).toBeUndefined();
    expect(port.describe("")).toBeUndefined();
  });

  it("matches the publisher's own homepage, with or without www", () => {
    expect(port.matchUrl("https://newsapi.org/")?.connectionId).toBe(NEWSAPI_CONNECTION_ID);
    expect(port.matchUrl("https://www.newsapi.org/pricing")?.connectionId).toBe(
      NEWSAPI_CONNECTION_ID
    );
    expect(port.matchUrl("https://NEWSAPI.ORG/")?.connectionId).toBe(NEWSAPI_CONNECTION_ID);
  });

  it("refuses a subdomain, a look-alike domain and a suffix match", () => {
    // Each of these would mean asking somebody to send their key to a publisher they did not
    // choose, which is the one failure this lookup exists to prevent.
    expect(port.matchUrl("https://blog.newsapi.org/")).toBeUndefined();
    expect(port.matchUrl("https://newsapi.org.evil.example/")).toBeUndefined();
    expect(port.matchUrl("https://notnewsapi.org/")).toBeUndefined();
    expect(port.matchUrl("https://newsapi.example/")).toBeUndefined();
  });

  it("refuses a plain-http address and an unparseable one", () => {
    expect(port.matchUrl("http://newsapi.org/")).toBeUndefined();
    expect(port.matchUrl("newsapi.org")).toBeUndefined();
    expect(port.matchUrl("")).toBeUndefined();
    expect(port.matchUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("still refuses to connect, because the live check belongs to #2006", async () => {
    await expect(port.validateKey(NEWSAPI_CONNECTION_ID, "fake-key-not-real")).resolves.toEqual({
      ok: false,
      reason: "unsupported"
    });
  });

  it("the do-nothing port answers nothing, so an unwired server offers no key box", () => {
    const empty = createEmptyNewsPublisherConnectionPort();
    expect(empty.matchUrl("https://newsapi.org/")).toBeUndefined();
    expect(empty.describe(NEWSAPI_CONNECTION_ID)).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------------------------
   The real preview route, with the real reviewed-publisher list behind it.
   --------------------------------------------------------------------------------------------- */

const user: AccessContext = {
  actorUserId: "00000000-0000-0000-0000-00000000000a",
  requestId: "req-preview-connection"
};

/** A minimal well-formed feed, so a fetched page verifies as a publisher with one headline. */
function feedPage(title: string): string {
  return (
    `<?xml version="1.0"?><rss><channel><title>${title}</title>` +
    `<item><title>${title} leads with a story</title>` +
    `<link>https://example.invalid/story</link>` +
    `<pubDate>Fri, 21 Aug 2026 12:00:00 GMT</pubDate></item></channel></rss>`
  );
}

/**
 * Serves the pages the test declares and nothing else, so an unexpected outbound address in the
 * resolution path shows up as a failed preview rather than passing silently.
 */
function servePages(pages: Readonly<Record<string, string>>): NewsSafeFetchPort {
  const byUrl = new Map(Object.entries(pages).map(([url, body]) => [new URL(url).toString(), body]));
  return async (url: string) => {
    const body = byUrl.get(new URL(url).toString());
    if (!body) return { ok: false, reason: "network" };
    return {
      ok: true,
      status: 200,
      finalUrl: new URL(url).toString(),
      contentType: "application/rss+xml",
      body,
      truncated: false
    };
  };
}

function emptyPersonalizationStore(): NewsPersonalizationStore {
  const source = (): NewsCustomSourceDto => {
    throw new Error("this test never writes a source");
  };
  const topic = (): NewsCustomTopicDto => {
    throw new Error("this test never writes a topic");
  };
  return {
    listCustomSources: async () => [],
    createCustomSource: async () => source(),
    replaceCustomSource: async () => source(),
    deleteCustomSource: async () => true,
    countCustomSources: async () => 0,
    countCustomTopics: async () => 0,
    listCustomTopics: async () => [],
    createCustomTopic: async () => topic(),
    updateCustomTopic: async () => topic(),
    deleteCustomTopic: async () => true,
    listExclusions: async (): Promise<NewsSourceExclusionDto[]> => [],
    createExclusion: async () => {
      throw new Error("this test never writes an exclusion");
    },
    removeExclusion: async () => true,
    readLatestSnapshot: async () => null,
    readRefreshState: async (): Promise<NewsRefreshStateDto> => ({ state: "idle", updatedAt: null }),
    bumpRefreshRequest: async () => 1,
    pruneSnapshotDomain: async () => undefined,
    readPolicyVerdict: async () => null,
    upsertPolicyVerdict: async () => undefined
  };
}

const unusedDatasetClient: DatasetClient = {
  async getDataset<T>(
    _key: string,
    _params: Record<string, unknown>,
    options: { fallback: T }
  ): Promise<DatasetEnvelope<T>> {
    return { data: options.fallback, degraded: true, fetchedAt: new Date().toISOString() };
  }
};

/**
 * Registers the whole News route surface, exactly as the running product does, and returns the
 * server. `wireConnections: false` stands in for a build where the composition root forgot to
 * pass the reviewed list.
 */
function buildNewsServer(options: {
  readonly pages: Readonly<Record<string, string>>;
  readonly searchResults?: readonly string[];
  readonly wireConnections?: boolean;
}) {
  const app = Fastify();
  registerNewsRoutes(app, {
    dataContext: {
      withDataContext: async <T>(_ac: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
        work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: async () => user,
    datasetClient: unusedDatasetClient,
    availability: { hasJsonModel: async () => true, hasWebSearch: async () => true },
    discovery: {
      fetch: servePages(options.pages),
      image: async () => ({ ok: false, reason: "network" }),
      search: {
        search: async () => ({
          results: (options.searchResults ?? []).map((url) => ({
            title: new URL(url).hostname,
            url,
            snippet: "A publication."
          }))
        })
      },
      ai: {
        generateJson: async () => ({
          ok: true,
          object: { allowed: true, category: "news_publisher" }
        }),
        fingerprint: async () => "test-fingerprint"
      }
    },
    boss: null,
    repository: {
      list: async () => [],
      create: async () => {
        throw new Error("this test never writes a preference");
      },
      remove: async () => true
    },
    personalizationRepository: emptyPersonalizationStore(),
    credentialCipher: {
      encrypt: () => ({ version: 1, algorithm: "aes-256-gcm", iv: "", tag: "", ciphertext: "" }),
      decrypt: () => ({ apiKey: "unused" })
    },
    ...(options.wireConnections === false
      ? {}
      : { publisherConnections: createRegistryNewsPublisherConnectionPort() })
  });
  return app;
}

/** Runs one real preview request and hands back the body as the browser would receive it. */
async function preview(
  input: string,
  options: {
    readonly pages: Readonly<Record<string, string>>;
    readonly searchResults?: readonly string[];
    readonly wireConnections?: boolean;
  }
): Promise<{
  readonly status: string;
  readonly candidates: readonly { readonly canonicalDomain: string }[];
  readonly connection?: NewsPublisherConnectionOfferDto;
}> {
  const app = buildNewsServer(options);
  await app.ready();
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input }
    });
    expect(response.statusCode).toBe(200);
    return JSON.parse(response.body);
  } finally {
    await app.close();
  }
}

describe("the preview route decides whether to ask for a key (#2008)", () => {
  const reviewedPublisherPages = { "https://newsapi.org": feedPage("NewsAPI") };

  it("offers the key box for the reviewed publisher, on the wire", async () => {
    const body = await preview("https://newsapi.org", { pages: reviewedPublisherPages });
    expect(body.status).toBe("ok");
    expect(body.candidates).toHaveLength(1);
    // The whole offer, as the browser receives it after response serialization. Anything the
    // response schema does not declare is dropped here, so this also proves the five display
    // fields survive and nothing else was smuggled alongside them.
    expect(body.connection).toEqual({
      connectionId: NEWSAPI_CONNECTION_ID,
      publisherName: newsApiConnection.publisherName,
      requestHost: "newsapi.org",
      accessSummary: newsApiConnection.accessSummary,
      termsUrl: newsApiConnection.termsUrl
    });
  });

  it("never puts the header name or the endpoint into the preview body", async () => {
    const app = buildNewsServer({ pages: reviewedPublisherPages });
    await app.ready();
    const response = await app.inject({
      method: "POST",
      url: "/api/news/sources/preview",
      payload: { input: "https://newsapi.org" }
    });
    expect(response.body).not.toContain(newsApiConnection.apiKeyHeader);
    expect(response.body).not.toContain(newsApiConnection.endpoint);
    await app.close();
  });

  it("offers nothing when the check found more than one publication", async () => {
    // The guard that matters: asking for a key on an ambiguous result means asking somebody to
    // send a secret to a publisher they did not pick. Delete the count check in the handler and
    // this test fails.
    const body = await preview("newsapi", {
      pages: {
        "https://newsapi.org": feedPage("NewsAPI"),
        "https://other-wire.example": feedPage("Other Wire")
      },
      searchResults: ["https://newsapi.org", "https://other-wire.example"]
    });
    expect(body.status).toBe("ambiguous");
    expect(body.candidates.map((candidate) => candidate.canonicalDomain)).toContain("newsapi.org");
    expect(body.connection).toBeUndefined();
  });

  it("offers nothing for a look-alike domain that is not the reviewed publisher", async () => {
    for (const homepage of [
      "https://blog.newsapi.org",
      "https://newsapi.org.evil.example",
      "https://notnewsapi.org"
    ]) {
      const body = await preview(homepage, { pages: { [homepage]: feedPage("Look-alike") } });
      expect(body.status).toBe("ok");
      expect(body.connection).toBeUndefined();
    }
  });

  it("offers nothing for an ordinary publication, which previews exactly as before", async () => {
    const body = await preview("https://plain-wire.example", {
      pages: { "https://plain-wire.example": feedPage("Plain Wire") }
    });
    expect(body.status).toBe("ok");
    expect(body.candidates).toHaveLength(1);
    expect(body.connection).toBeUndefined();
  });

  it("offers nothing when the reviewed list was never wired into the server", async () => {
    const body = await preview("https://newsapi.org", {
      pages: reviewedPublisherPages,
      wireConnections: false
    });
    expect(body.status).toBe("ok");
    expect(body.connection).toBeUndefined();
  });
});

describe("the running product actually gets the reviewed list (#2008)", () => {
  // The test above proves the route behaves correctly when the reviewed list is handed to it.
  // This one pins the single line that hands it over. It reads the composition root as text
  // rather than booting it, because booting it needs a database; a text check is a weak test in
  // general, but the mistake it catches - News quietly wired back to the do-nothing list, so no
  // key box ever appears - is exactly a one-word edit on this line.
  const compositionRoot = readFileSync(
    fileURLToPath(new URL("../../packages/module-registry/src/index.ts", import.meta.url)),
    "utf8"
  );

  it("hands News the reviewed publisher list, not the do-nothing one", () => {
    expect(compositionRoot).toContain(
      "publisherConnections: createRegistryNewsPublisherConnectionPort()"
    );
    expect(compositionRoot).not.toContain(
      "publisherConnections: createEmptyNewsPublisherConnectionPort()"
    );
  });
});
