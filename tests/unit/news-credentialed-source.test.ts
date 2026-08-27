import { describe, expect, it } from "vitest";

import {
  createCredentialedPublisherAdapter,
  CredentialedPublisherError,
  toCredentialedHeadline
} from "../../packages/news/src/source/credentialed-source.js";
import {
  NEWSAPI_DATASET_KEY,
  newsApiConnection
} from "../../packages/news/src/source/newsapi-connection.js";
import type {
  PublisherConnection,
  SanitizedPublisherItem
} from "../../packages/news/src/source/publisher-connection.js";
import type { ExternalSourceAdapterContext } from "../../packages/module-sdk/src/external-module.js";

const API_KEY = "super-secret-key-value";

interface Call {
  readonly url: string;
  readonly headers: Record<string, string>;
}

function recordingFetch(respond: (url: string) => Response | Promise<Response>): {
  fetchFn: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>
    )) {
      headers[name] = value;
    }
    calls.push({ url, headers });
    return respond(url);
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function article(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "A headline",
    url: "https://example.com/story-1",
    publishedAt: "2026-08-20T10:00:00.000Z",
    description: "Some summary text",
    source: { name: "Example Times" },
    ...overrides
  };
}

function okBody(articles: readonly unknown[]): unknown {
  return { status: "ok", totalResults: articles.length, articles };
}

function ctx(fetchFn: typeof fetch, apiKey: string | undefined = API_KEY) {
  return { fetchFn, apiKey } as ExternalSourceAdapterContext;
}

async function callAdapter(
  connection: PublisherConnection,
  fetchFn: typeof fetch,
  params: Record<string, unknown>,
  apiKey: string | undefined = API_KEY
): Promise<unknown> {
  const adapter = createCredentialedPublisherAdapter(connection);
  return adapter.fetchDataset(NEWSAPI_DATASET_KEY, params, ctx(fetchFn, apiKey));
}

describe("credentialed publisher adapter — the key travels in the header only", () => {
  it("sends the key in the declared header and nowhere in the URL", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(okBody([article()])));
    await callAdapter(newsApiConnection, fetchFn, { topicKey: null });

    expect(calls).toHaveLength(1);
    expect(calls[0].headers[newsApiConnection.apiKeyHeader]).toBe(API_KEY);
    expect(calls[0].url).not.toContain(API_KEY);
    expect(new URL(calls[0].url).search).not.toContain(API_KEY);
  });

  it("makes no request at all when the runtime supplied no key", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(okBody([article()])));
    const adapter = createCredentialedPublisherAdapter(newsApiConnection);
    await expect(
      adapter.fetchDataset(NEWSAPI_DATASET_KEY, { topicKey: null }, {
        fetchFn
      } as ExternalSourceAdapterContext)
    ).rejects.toMatchObject({ failure: "temporarily_unavailable" });
    expect(calls).toHaveLength(0);
  });

  it("makes no request when the supplied key is blank", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(okBody([article()])));
    await expect(
      callAdapter(newsApiConnection, fetchFn, { topicKey: null }, "   ")
    ).rejects.toMatchObject({ failure: "temporarily_unavailable" });
    expect(calls).toHaveLength(0);
  });
});

describe("credentialed publisher adapter — the outgoing request is fully declared", () => {
  const topics = Object.keys(newsApiConnection.topicQuery).filter((key) => key !== "default");

  for (const topic of [...topics, "not-a-topic", null]) {
    it(`builds the declared endpoint and query for topic ${String(topic)}`, async () => {
      const { fetchFn, calls } = recordingFetch(() => jsonResponse(okBody([article()])));
      await callAdapter(newsApiConnection, fetchFn, { topicKey: topic });

      const url = new URL(calls[0].url);
      expect(`${url.origin}${url.pathname}`).toBe(newsApiConnection.endpoint);

      const expected = new Map<string, string>();
      for (const [name, value] of Object.entries(newsApiConnection.fixedQuery)) {
        expected.set(name, value);
      }
      const topicValues =
        (topic !== null && newsApiConnection.topicQuery[topic]) ||
        newsApiConnection.topicQuery.default;
      for (const [name, value] of Object.entries(topicValues)) {
        expected.set(name, value);
      }

      expect([...url.searchParams.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [name, value] of expected) {
        expect(url.searchParams.get(name)).toBe(value);
      }
    });
  }

  it("ignores caller-supplied params other than the topic", async () => {
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(okBody([article()])));
    await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null,
      q: "anything",
      apiKey: "attacker-value",
      country: "ru"
    });

    const url = new URL(calls[0].url);
    expect(url.searchParams.get("q")).toBeNull();
    expect(url.searchParams.get("apiKey")).toBeNull();
    expect(url.searchParams.get("country")).toBeNull();
  });
});

describe("credentialed publisher adapter — the response is sanitized and bounded", () => {
  it("parses a good response into sanitized items", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(okBody([article(), article({ url: "https://example.com/story-2" })]))
    );
    const items = (await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null
    })) as SanitizedPublisherItem[];

    expect(items).toHaveLength(2);
    expect(items[0].title).toBe("A headline");
    expect(items[0].url).toBe("https://example.com/story-1");
    expect(items[0].providerName).toBe("Example Times");
  });

  it("caps the item count at the declared maximum", async () => {
    const many = Array.from({ length: newsApiConnection.maxItems + 15 }, (_unused, index) =>
      article({ url: `https://example.com/story-${index}` })
    );
    const { fetchFn } = recordingFetch(() => jsonResponse(okBody(many)));
    const items = (await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null
    })) as SanitizedPublisherItem[];

    expect(items).toHaveLength(newsApiConnection.maxItems);
  });

  it("drops items with no usable link or no title", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(
        okBody([
          article({ url: null }),
          article({ url: "http://example.com/insecure" }),
          article({ url: "https://example.com/no-title", title: "   " }),
          article({ url: "https://example.com/keeper" })
        ])
      )
    );
    const items = (await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null
    })) as SanitizedPublisherItem[];

    expect(items.map((item) => item.url)).toEqual(["https://example.com/keeper"]);
  });

  it("never carries an image URL through this connection", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(okBody([article({ urlToImage: "https://cdn.example.com/pic.jpg" })]))
    );
    const items = (await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null
    })) as SanitizedPublisherItem[];

    expect(items[0].imageUrl).toBeNull();
  });

  it("strips markup, caps over-long text and drops a garbled published time", async () => {
    const { fetchFn } = recordingFetch(() =>
      jsonResponse(
        okBody([
          article({
            title: "<b>Bold</b> &amp; brash",
            description: "x".repeat(2_000),
            publishedAt: "not a date"
          })
        ])
      )
    );
    const items = (await callAdapter(newsApiConnection, fetchFn, {
      topicKey: null
    })) as SanitizedPublisherItem[];

    expect(items[0].title).toBe("Bold & brash");
    expect(items[0].title).not.toContain("<");
    expect(items[0].summary.length).toBeLessThan(600);
    expect(items[0].summary.endsWith("…")).toBe(true);
    expect(items[0].publishedAt).toBeNull();
  });

  it("reports a failure rather than an empty answer when the response is truncated", async () => {
    const { fetchFn } = recordingFetch(
      () => new Response('{"status":"ok","articles":[', { status: 200 })
    );
    await expect(callAdapter(newsApiConnection, fetchFn, { topicKey: null })).rejects.toMatchObject(
      { failure: "temporarily_unavailable" }
    );
  });

  it("reports a failure when the response is not the documented shape", async () => {
    const { fetchFn } = recordingFetch(() => jsonResponse({ status: "error", code: "apiKeyInvalid" }));
    await expect(callAdapter(newsApiConnection, fetchFn, { topicKey: null })).rejects.toMatchObject(
      { failure: "temporarily_unavailable" }
    );
  });
});

describe("credentialed publisher adapter — failures say only what the person can act on", () => {
  const cases: ReadonlyArray<readonly [number, string]> = [
    [401, "authentication_failed"],
    [403, "authentication_failed"],
    [429, "temporarily_unavailable"],
    [500, "temporarily_unavailable"],
    [502, "temporarily_unavailable"],
    [503, "temporarily_unavailable"],
    [400, "temporarily_unavailable"],
    [404, "temporarily_unavailable"]
  ];

  for (const [status, failure] of cases) {
    it(`maps status ${status} to ${failure}`, async () => {
      const { fetchFn } = recordingFetch(
        () =>
          new Response(`{"status":"error","message":"key ${API_KEY} rejected"}`, {
            status,
            headers: { "content-type": "application/json" }
          })
      );
      const error = await callAdapter(newsApiConnection, fetchFn, { topicKey: null }).then(
        () => null,
        (caught: unknown) => caught
      );

      expect(error).toBeInstanceOf(CredentialedPublisherError);
      expect((error as CredentialedPublisherError).failure).toBe(failure);
    });
  }

  it("maps a connection error to temporarily unavailable", async () => {
    const fetchFn = (async () => {
      throw new Error(`connect ECONNREFUSED to ${newsApiConnection.endpoint}?key=${API_KEY}`);
    }) as unknown as typeof fetch;

    const error = await callAdapter(newsApiConnection, fetchFn, { topicKey: null }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect((error as CredentialedPublisherError).failure).toBe("temporarily_unavailable");
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it("maps a timeout to temporarily unavailable", async () => {
    const fetchFn = (async () => {
      const timeout = new Error("The operation was aborted due to timeout");
      timeout.name = "TimeoutError";
      throw timeout;
    }) as unknown as typeof fetch;

    const error = await callAdapter(newsApiConnection, fetchFn, { topicKey: null }).then(
      () => null,
      (caught: unknown) => caught
    );
    expect((error as CredentialedPublisherError).failure).toBe("temporarily_unavailable");
  });

  it("carries no key, header value, URL or upstream text on the thrown error", async () => {
    const { fetchFn } = recordingFetch(
      () =>
        new Response(`{"message":"Your API key ${API_KEY} is invalid"}`, {
          status: 401
        })
    );
    const error = (await callAdapter(newsApiConnection, fetchFn, { topicKey: null }).then(
      () => null,
      (caught: unknown) => caught
    )) as CredentialedPublisherError;

    const surfaces = [error.message, error.stack ?? "", String(error), JSON.stringify(error)];
    for (const surface of surfaces) {
      expect(surface).not.toContain(API_KEY);
      expect(surface).not.toContain("newsapi.org");
      expect(surface).not.toContain("X-Api-Key");
      expect(surface).not.toContain("invalid");
    }
    expect(error.message).toBe("authentication failed");
    expect((error as unknown as { cause?: unknown }).cause).toBeUndefined();
  });

  it("says temporarily unavailable in plain words", () => {
    expect(new CredentialedPublisherError("temporarily_unavailable").message).toBe(
      "temporarily unavailable"
    );
  });
});

describe("toCredentialedHeadline", () => {
  const item: SanitizedPublisherItem = {
    id: "ignored-upstream-id",
    title: "A headline",
    url: "https://example.com/story-1",
    publishedAt: "2026-08-20T10:00:00.000Z",
    imageUrl: null,
    summary: "Some summary text",
    providerName: "Example Times"
  };

  it("keeps the publisher's own name as the source label", () => {
    const headline = toCredentialedHeadline(item, {
      sourceKey: "newsapi",
      topicKey: "business",
      topicLabel: "Business"
    });

    expect(headline.sourceLabel).toBe("Example Times");
    expect(headline.sourceKey).toBe("newsapi");
    expect(headline.topicKey).toBe("business");
    expect(headline.topicLabel).toBe("Business");
    expect(headline.title).toBe("A headline");
    expect(headline.url).toBe("https://example.com/story-1");
    expect(headline.publishedAt).toBe("2026-08-20T10:00:00.000Z");
    expect(headline.imageUrl).toBeNull();
    expect(headline.summary).toBe("Some summary text");
  });

  it("derives the id from the article link so the same story dedupes across sources", () => {
    const headline = toCredentialedHeadline(item, {
      sourceKey: "newsapi",
      topicKey: null,
      topicLabel: null
    });
    const other = toCredentialedHeadline(
      { ...item, id: "a-different-upstream-id", title: "Reworded" },
      { sourceKey: "somewhere-else", topicKey: null, topicLabel: null }
    );

    expect(headline.id).toBe(other.id);
    expect(headline.id).not.toBe("ignored-upstream-id");
  });
});
