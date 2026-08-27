import { describe, expect, it } from "vitest";

import {
  ALLOWED_API_KEY_HEADERS,
  assertValidPublisherConnection,
  assertValidPublisherConnectionRegistry,
  PUBLISHER_MAX_ITEMS,
  PUBLISHER_MAX_RESPONSE_BYTES,
  PUBLISHER_MAX_TIMEOUT_MS,
  type PublisherConnection
} from "../../packages/news/src/source/publisher-connection.js";
import {
  newsApiConnection,
  NEWSAPI_CONNECTION_ID,
  publisherConnection,
  PUBLISHER_CONNECTIONS
} from "../../packages/news/src/source/newsapi-connection.js";

// A minimal declaration that passes every check; each test below breaks exactly one thing, so a
// failure names the rule that stopped enforcing rather than "something in the fixture".
function connection(overrides: Partial<PublisherConnection> = {}): PublisherConnection {
  return {
    id: "fixture-connection",
    publisherName: "Fixture Wire",
    canonicalDomain: "fixture.example",
    homepageUrl: "https://fixture.example/",
    fetchHosts: ["fixture.example"],
    endpoint: "https://fixture.example/v1/headlines",
    method: "GET",
    apiKeyHeader: "X-Api-Key",
    fixedQuery: { language: "en" },
    topicQuery: { default: { category: "general" } },
    timeoutMs: 5_000,
    maxResponseBytes: 100_000,
    maxItems: 10,
    minIntervalMs: 1_000,
    parse: () => [],
    ...overrides
  };
}

describe("publisher connection validation", () => {
  it("accepts a well-formed declaration", () => {
    expect(() => assertValidPublisherConnection(connection())).not.toThrow();
  });

  it("rejects an endpoint that is not HTTPS", () => {
    expect(() =>
      assertValidPublisherConnection(
        connection({ endpoint: "http://fixture.example/v1/headlines" })
      )
    ).toThrow(/https/i);
  });

  it("rejects an endpoint whose host is not on its own host list", () => {
    expect(() =>
      assertValidPublisherConnection(connection({ endpoint: "https://elsewhere.example/v1" }))
    ).toThrow(/host/i);
  });

  it("rejects an endpoint that is not a parseable URL", () => {
    expect(() => assertValidPublisherConnection(connection({ endpoint: "not a url" }))).toThrow(
      /endpoint/i
    );
  });

  it("rejects an empty host list", () => {
    expect(() => assertValidPublisherConnection(connection({ fetchHosts: [] }))).toThrow();
  });

  it.each([["203.0.113.10"], ["fixture.example:8443"], ["Fixture.Example"]])(
    "rejects the unusable host %s",
    (host) => {
      expect(() =>
        assertValidPublisherConnection(
          connection({ fetchHosts: [host], endpoint: `https://${host}/v1` })
        )
      ).toThrow();
    }
  );

  it("rejects a method other than GET", () => {
    expect(() =>
      assertValidPublisherConnection(
        connection({ method: "POST" as unknown as PublisherConnection["method"] })
      )
    ).toThrow(/GET/);
  });

  it.each([[""], ["   "], ["X Api Key"], ["X-Api-Key\nX-Evil"], ["X-Made-Up-Header"]])(
    "rejects the key header name %j",
    (apiKeyHeader) => {
      expect(() => assertValidPublisherConnection(connection({ apiKeyHeader }))).toThrow(/header/i);
    }
  );

  it("only allows key header names that are written down in the allow list", () => {
    expect(ALLOWED_API_KEY_HEADERS.length).toBeGreaterThan(0);
    for (const header of ALLOWED_API_KEY_HEADERS) {
      expect(() => assertValidPublisherConnection(connection({ apiKeyHeader: header }))).not.toThrow();
    }
  });

  it.each([["apiKey"], ["api_key"], ["api-key"], ["APIKEY"], ["key"], ["token"], ["authorization"]])(
    "rejects a fixed query value named %s, because that is the key in the URL",
    (name) => {
      expect(() =>
        assertValidPublisherConnection(connection({ fixedQuery: { [name]: "en" } }))
      ).toThrow(/query/i);
    }
  );

  it("rejects a secret-looking query name in the topic table too", () => {
    expect(() =>
      assertValidPublisherConnection(
        connection({ topicQuery: { default: { apiKey: "general" } } })
      )
    ).toThrow(/query/i);
  });

  it.each([["{apiKey}"], ["${SECRET}"], ["the-api-key"], ["bearer token"], ["my-secret"]])(
    "rejects the placeholder query value %j",
    (value) => {
      expect(() =>
        assertValidPublisherConnection(connection({ fixedQuery: { language: value } }))
      ).toThrow(/query/i);
    }
  );

  it.each([
    ["timeoutMs", 0],
    ["timeoutMs", PUBLISHER_MAX_TIMEOUT_MS + 1],
    ["maxResponseBytes", 0],
    ["maxResponseBytes", PUBLISHER_MAX_RESPONSE_BYTES + 1],
    ["maxItems", 0],
    ["maxItems", PUBLISHER_MAX_ITEMS + 1]
  ] as const)("rejects %s set to %d", (field, value) => {
    expect(() => assertValidPublisherConnection(connection({ [field]: value }))).toThrow();
  });

  it("rejects a bound that is missing entirely", () => {
    const missing = connection();
    expect(() =>
      assertValidPublisherConnection({
        ...missing,
        timeoutMs: undefined as unknown as number
      })
    ).toThrow();
  });

  it("rejects a minimum gap below the floor", () => {
    expect(() => assertValidPublisherConnection(connection({ minIntervalMs: 1 }))).toThrow(
      /interval/i
    );
  });

  it("rejects a declaration with no parser", () => {
    expect(() =>
      assertValidPublisherConnection(
        connection({ parse: undefined as unknown as PublisherConnection["parse"] })
      )
    ).toThrow(/parser/i);
  });

  it("rejects a registry that reuses a connection id", () => {
    expect(() =>
      assertValidPublisherConnectionRegistry([
        connection({ id: "same" }),
        connection({ id: "same" })
      ])
    ).toThrow(/duplicate/i);
  });
});

describe("the reviewed connection registry", () => {
  it("passes validation", () => {
    expect(() => assertValidPublisherConnectionRegistry(PUBLISHER_CONNECTIONS)).not.toThrow();
  });

  it("holds exactly the one reviewed connection", () => {
    expect(PUBLISHER_CONNECTIONS.map((entry) => entry.id)).toEqual([NEWSAPI_CONNECTION_ID]);
  });

  it("cannot be extended at runtime", () => {
    expect(Object.isFrozen(PUBLISHER_CONNECTIONS)).toBe(true);
    expect(() =>
      (PUBLISHER_CONNECTIONS as PublisherConnection[]).push(connection())
    ).toThrow(TypeError);
  });

  it("looks a connection up by id and answers nothing for an unknown one", () => {
    expect(publisherConnection(NEWSAPI_CONNECTION_ID)).toBe(newsApiConnection);
    expect(publisherConnection("not-a-connection")).toBeUndefined();
  });

  it("sends the key in a header and never in the query string", () => {
    expect(newsApiConnection.apiKeyHeader).toBe("X-Api-Key");
    const queryNames = [
      ...Object.keys(newsApiConnection.fixedQuery),
      ...Object.values(newsApiConnection.topicQuery).flatMap((values) => Object.keys(values))
    ];
    expect(queryNames.some((name) => /key|token|auth|secret/i.test(name))).toBe(false);
  });

  it("keeps its bounds inside the module-wide ceilings", () => {
    expect(newsApiConnection.timeoutMs).toBeLessThanOrEqual(PUBLISHER_MAX_TIMEOUT_MS);
    expect(newsApiConnection.maxResponseBytes).toBeLessThanOrEqual(PUBLISHER_MAX_RESPONSE_BYTES);
    expect(newsApiConnection.maxItems).toBeLessThanOrEqual(PUBLISHER_MAX_ITEMS);
  });

  it("maps every news topic, plus a fallback for one it does not know", () => {
    for (const topic of [
      "world",
      "us",
      "politics",
      "business",
      "technology",
      "science",
      "health",
      "culture"
    ]) {
      expect(newsApiConnection.topicQuery[topic]).toBeDefined();
    }
    expect(newsApiConnection.topicQuery.default).toBeDefined();
  });
});
