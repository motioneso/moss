import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext } from "@moss/db";
import { HttpError } from "@moss/module-sdk";

import {
  NEWS_FAVICON_MAX_BYTES,
  registerNewsFaviconRoute,
  sniffedFaviconType
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

function buildApp(input: {
  fetchImage?: NewsImageFetchPort;
  resolveAccessContext?: () => Promise<AccessContext>;
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
      }))
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

describe("sniffedFaviconType", () => {
  it("returns null for unrecognized bytes", () => {
    expect(sniffedFaviconType(new TextEncoder().encode("<svg></svg>"))).toBeNull();
  });
});
