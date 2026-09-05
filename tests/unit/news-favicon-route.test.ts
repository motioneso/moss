import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import {
  NEWS_FAVICON_MAX_BYTES,
  faviconFetchHosts,
  registerNewsFaviconRoute,
  sniffedFaviconType,
  type NewsFaviconCustomSourcePort
} from "../../packages/news/src/favicon-route.js";
import type { NewsImageFetchPort } from "../../packages/news/src/discovery/ports.js";

const user: AccessContext = { actorUserId: "user-a", requestId: "request-a" };
const ico = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 1, 2, 3]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const signatures = [
  ["image/x-icon", ico],
  ["image/png", png],
  ["image/webp", new TextEncoder().encode("RIFF1234WEBP")],
  ["image/gif", new TextEncoder().encode("GIF89a")]
] as const;

// None of the routes under test here exercise the publisher-restriction check itself (that has
// its own test below), so this stands in for "the requester saved every domain these tests use
// as a custom source" — every domain the rest of this file requests is pre-approved.
const genericApprovedDomains = [
  "example.com",
  ...Array.from({ length: 200 }, (_, index) => `site-${index}.example`)
];
const allDomainsApproved: NewsFaviconCustomSourcePort = {
  listCustomSources: async () =>
    genericApprovedDomains.map((canonicalDomain) => ({ canonicalDomain }))
};
const noCustomSources: NewsFaviconCustomSourcePort = {
  listCustomSources: async () => []
};
const dataContext = {
  withDataContext: async (_accessContext: AccessContext, run: (db: DataContextDb) => unknown) =>
    run({} as DataContextDb)
} as unknown as DataContextRunner;

function buildApp(input: {
  fetchImage?: NewsImageFetchPort;
  resolveAccessContext?: () => Promise<AccessContext>;
  customSources?: NewsFaviconCustomSourcePort;
}) {
  const app = Fastify();
  registerNewsFaviconRoute(app, {
    resolveAccessContext: input.resolveAccessContext ?? (async () => user),
    fetchImage:
      input.fetchImage ??
      (async () => ({
        ok: true as const,
        contentType: "image/x-icon",
        body: ico,
        truncated: false
      })),
    dataContext,
    customSources: input.customSources ?? allDomainsApproved
  });
  return app;
}

describe("news favicon route", () => {
  it("serves a favicon with private nosniff headers and caches by domain", async () => {
    let fetches = 0;
    const app = buildApp({
      fetchImage: async (url, maxBytes) => {
        fetches += 1;
        expect(url).toBe("https://example.com/favicon.ico");
        expect(maxBytes).toBe(NEWS_FAVICON_MAX_BYTES);
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: false };
      }
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: "GET", url: "/api/news/favicon/example.com" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/x-icon");
      expect(response.headers["cache-control"]).toBe("private, max-age=86400");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect([...response.rawPayload]).toEqual([...ico]);
    }
    expect(fetches).toBe(1);
    await app.close();
  });

  it.each(signatures)("serves validated %s bytes", async (contentType, body) => {
    const app = buildApp({
      fetchImage: async () => ({
        ok: true,
        contentType: "application/octet-stream",
        body,
        truncated: false
      })
    });

    const response = await app.inject({ method: "GET", url: "/api/news/favicon/example.com" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(contentType);
    expect(response.rawPayload).toEqual(Buffer.from(body));
    await app.close();
  });

  it("rejects a path that is not a bare hostname", async () => {
    const app = buildApp({});
    const response = await app.inject({
      method: "GET",
      url: "/api/news/favicon/not%20a%20domain"
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });

  it("returns 404 (so the front end falls back to the publisher name) on fetch failure, truncation, or an unrecognized signature", async () => {
    const failures: Array<Awaited<ReturnType<NewsImageFetchPort>>> = [
      { ok: false, reason: "http_error" },
      { ok: true, contentType: "image/x-icon", body: ico, truncated: true },
      {
        ok: true,
        contentType: "text/html",
        body: new TextEncoder().encode("<html></html>"),
        truncated: false
      }
    ];
    for (const failure of failures) {
      const app = buildApp({ fetchImage: async () => failure });
      const response = await app.inject({ method: "GET", url: "/api/news/favicon/example.com" });
      expect(response.statusCode).toBe(404);
      await app.close();
    }
  });

  it("evicts the oldest favicon after 128 entries", async () => {
    let fetches = 0;
    const app = buildApp({
      fetchImage: async () => {
        fetches += 1;
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: false };
      }
    });

    for (let index = 0; index < 129; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/news/favicon/site-${index}.example`
      });
      expect(response.statusCode).toBe(200);
    }
    await app.inject({ method: "GET", url: "/api/news/favicon/site-0.example" });

    expect(fetches).toBe(130);
    await app.close();
  });

  it("evicts the oldest favicon before cached bytes exceed 4 MiB", async () => {
    // Each favicon is 200 KiB (under the 256 KiB per-fetch cap), so roughly 20 fit in the 4 MiB
    // cache before the byte cap — not the 128-entry cap — forces an eviction.
    const body = new Uint8Array(200 * 1024);
    body.set(ico.subarray(0, 4));
    let fetches = 0;
    const app = buildApp({
      fetchImage: async () => {
        fetches += 1;
        return { ok: true, contentType: "image/x-icon", body, truncated: false };
      }
    });

    for (let index = 0; index < 21; index += 1) {
      const response = await app.inject({
        method: "GET",
        url: `/api/news/favicon/site-${index}.example`
      });
      expect(response.statusCode).toBe(200);
    }
    await app.inject({ method: "GET", url: "/api/news/favicon/site-0.example" });

    expect(fetches).toBe(22);
    await app.close();
  });

  it("refuses a domain that is not an approved publisher, before any download is attempted", async () => {
    let downloadAttempted = false;
    const app = buildApp({
      fetchImage: async () => {
        downloadAttempted = true;
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: false };
      },
      customSources: noCustomSources
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/news/favicon/not-a-registered-publisher.example"
    });

    expect(response.statusCode).toBe(404);
    expect(downloadAttempted).toBe(false);
    await app.close();
  });

  it("serves a favicon for a domain the requesting user saved as a custom source", async () => {
    const app = buildApp({
      customSources: {
        listCustomSources: async () => [{ canonicalDomain: "readers-own-source.example" }]
      },
      fetchImage: async () => ({
        ok: true,
        contentType: "image/x-icon",
        body: ico,
        truncated: false
      })
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/news/favicon/readers-own-source.example"
    });

    expect(response.statusCode).toBe(200);
    await app.close();
  });

  it("lets a built-in publisher's download follow a redirect onto its declared image hosts, and nowhere else (#2291)", async () => {
    // NPR answers /favicon.ico with a redirect to media.npr.org, which the catalog already lists
    // as one of NPR's image hosts. The fetch port refuses any hop outside this list, so the
    // list itself is the rule under test.
    let hostsGiven: readonly string[] | undefined;
    const app = buildApp({
      customSources: noCustomSources,
      fetchImage: async (url, _maxBytes, allowedHosts) => {
        expect(url).toBe("https://www.npr.org/favicon.ico");
        hostsGiven = allowedHosts;
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: false };
      }
    });

    const response = await app.inject({ method: "GET", url: "/api/news/favicon/www.npr.org" });

    expect(response.statusCode).toBe(200);
    expect(hostsGiven).toEqual(
      expect.arrayContaining(["www.npr.org", "media.npr.org", "npr.brightspotcdn.com"])
    );
    // Only NPR's own hosts: another publisher's image host is not a place NPR's icon may come from.
    expect(hostsGiven).not.toContain("ichef.bbci.co.uk");
    expect(hostsGiven).not.toContain("static01.nyt.com");
    await app.close();
  });

  it("keeps a custom source's download on its own host, since it declares no image hosts", async () => {
    let hostsGiven: readonly string[] | undefined;
    const app = buildApp({
      customSources: {
        listCustomSources: async () => [{ canonicalDomain: "readers-own-source.example" }]
      },
      fetchImage: async (_url, _maxBytes, allowedHosts) => {
        hostsGiven = allowedHosts;
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: false };
      }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/news/favicon/readers-own-source.example"
    });

    expect(response.statusCode).toBe(200);
    expect(hostsGiven).toEqual(["readers-own-source.example"]);
    await app.close();
  });

  it("requires authentication", async () => {
    const app = buildApp({
      resolveAccessContext: async () => {
        throw new HttpError(401, "Authentication required");
      }
    });
    const response = await app.inject({ method: "GET", url: "/api/news/favicon/example.com" });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("faviconFetchHosts", () => {
  it("is the requested host plus the catalog publisher's declared image hosts, lower-cased and deduplicated", () => {
    const hosts = faviconFetchHosts("WWW.NPR.ORG");
    expect(hosts[0]).toBe("www.npr.org");
    expect(hosts).toContain("media.npr.org");
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it("is just the requested host for a domain no built-in publisher owns", () => {
    expect(faviconFetchHosts("readers-own-source.example")).toEqual(["readers-own-source.example"]);
  });
});

describe("sniffedFaviconType", () => {
  it("returns null for unrecognized bytes", () => {
    expect(sniffedFaviconType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});
