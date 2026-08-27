// #2008 — the rule that decides whether News asks somebody for a secret.
//
// A key box must appear only when the preview found exactly one candidate AND that candidate's
// homepage is unmistakably a reviewed publisher's own address. Every other shape of preview must
// come back byte for byte as it does today. These tests exercise the registry-backed port
// directly, because that port is where the decision is made.
import { describe, expect, it } from "vitest";

import { createRegistryNewsPublisherConnectionPort } from "../../packages/news/src/source/publisher-connection-registry.js";
import { createEmptyNewsPublisherConnectionPort } from "../../packages/news/src/publisher-connection-port.js";
import {
  newsApiConnection,
  NEWSAPI_CONNECTION_ID
} from "../../packages/news/src/source/newsapi-connection.js";

const port = createRegistryNewsPublisherConnectionPort();

/**
 * The same shape the preview handler builds its offer from. Kept here rather than imported so a
 * change to the handler's display fields has to be made deliberately in both places.
 */
function offerFrom(homepageUrl: string) {
  const descriptor = port.matchUrl(homepageUrl);
  if (!descriptor) return undefined;
  return {
    connectionId: descriptor.connectionId,
    publisherName: descriptor.publisherName,
    requestHost: descriptor.host,
    accessSummary: descriptor.accessSummary,
    termsUrl: descriptor.termsUrl
  };
}

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
    expect(offerFrom("https://newsapi.org/")?.connectionId).toBe(NEWSAPI_CONNECTION_ID);
    expect(offerFrom("https://www.newsapi.org/pricing")?.connectionId).toBe(NEWSAPI_CONNECTION_ID);
    expect(offerFrom("https://NEWSAPI.ORG/")?.connectionId).toBe(NEWSAPI_CONNECTION_ID);
  });

  it("carries only the five display fields into the offer", () => {
    expect(offerFrom("https://newsapi.org/")).toEqual({
      connectionId: NEWSAPI_CONNECTION_ID,
      publisherName: "NewsAPI",
      requestHost: "newsapi.org",
      accessSummary: newsApiConnection.accessSummary,
      termsUrl: newsApiConnection.termsUrl
    });
  });

  it("refuses a subdomain, a look-alike domain and a suffix match", () => {
    // Each of these would mean asking somebody to send their key to a publisher they did not
    // choose, which is the one failure this lookup exists to prevent.
    expect(offerFrom("https://blog.newsapi.org/")).toBeUndefined();
    expect(offerFrom("https://newsapi.org.evil.example/")).toBeUndefined();
    expect(offerFrom("https://notnewsapi.org/")).toBeUndefined();
    expect(offerFrom("https://newsapi.example/")).toBeUndefined();
  });

  it("refuses a plain-http address and an unparseable one", () => {
    expect(offerFrom("http://newsapi.org/")).toBeUndefined();
    expect(offerFrom("newsapi.org")).toBeUndefined();
    expect(offerFrom("")).toBeUndefined();
    expect(offerFrom("javascript:alert(1)")).toBeUndefined();
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
