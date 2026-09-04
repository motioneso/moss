import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { AccessContext, DataContextDb, DataContextRunner } from "@moss/db";

import {
  SPORTS_ICON_MAX_BYTES,
  SPORTS_ICON_TIMEOUT_MS,
  registerSportsSourceIconRoute,
  sniffSportsIconType,
  sportsIconCandidateUrls,
  type SportsIconFetchPort,
  type SportsIconSourceRecord
} from "../../packages/sports/src/source/icon-route.js";

const user: AccessContext = { actorUserId: "user-a", requestId: "request-a" };
const sourceId = "11111111-1111-1111-1111-111111111111";
const ico = Uint8Array.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
const accepted = [
  ["image/x-icon", ico],
  ["image/png", png],
  ["image/jpeg", Uint8Array.from([0xff, 0xd8, 0xff, 1])],
  ["image/gif", new TextEncoder().encode("GIF89a")],
  ["image/webp", new TextEncoder().encode("RIFF1234WEBP")]
] as const;
const rejected = [
  ["html", new TextEncoder().encode("<!doctype html><html><body>404</body></html>")],
  [
    "svg",
    new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')
  ],
  ["empty", new Uint8Array()]
] as const;

function okFetch(body: Uint8Array, contentType: string | null = null): SportsIconFetchPort {
  return async () => ({ ok: true, contentType, body, truncated: false });
}

function buildApp(input: {
  source?: SportsIconSourceRecord | null;
  fetchBytes?: SportsIconFetchPort;
  now?: () => Date;
}) {
  const app = Fastify();
  registerSportsSourceIconRoute(app, {
    dataContext: {
      withDataContext: async <T>(
        _accessContext: AccessContext,
        work: (db: DataContextDb) => Promise<T>
      ) => work({} as DataContextDb)
    } as unknown as DataContextRunner,
    resolveAccessContext: async () => user,
    repository: {
      findById: async (_db, id) =>
        input.source === null ? null : id === sourceId ? (input.source ?? record()) : null
    },
    fetchBytes: input.fetchBytes ?? okFetch(ico, "image/x-icon"),
    ...(input.now ? { now: input.now } : {})
  });
  return app;
}

function record(canonicalDomain = "example.com"): SportsIconSourceRecord {
  return { id: sourceId, canonicalDomain, iconUrl: null };
}

const url = `/api/sports/sources/${sourceId}/icon`;

describe("sports source icon sniffing", () => {
  it.each(accepted)("accepts %s by magic bytes", (contentType, body) => {
    expect(sniffSportsIconType(body)).toBe(contentType);
  });

  it.each(rejected)("rejects %s", (_label, body) => {
    expect(sniffSportsIconType(body)).toBeNull();
  });

  it("tries the bare domain then www, and skips www when already present", () => {
    expect(sportsIconCandidateUrls("Example.com")).toEqual([
      "https://example.com/favicon.ico",
      "https://www.example.com/favicon.ico"
    ]);
    expect(sportsIconCandidateUrls("www.example.com")).toEqual([
      "https://www.example.com/favicon.ico"
    ]);
  });
});

describe("sports source icon route", () => {
  it("answers 404 for an unknown or another user's source id", async () => {
    let fetches = 0;
    const app = buildApp({
      source: null,
      fetchBytes: async () => {
        fetches += 1;
        return { ok: false, reason: "blocked" };
      }
    });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
    expect(fetches).toBe(0);
    await app.close();
  });

  it("serves the sniffed icon with private day-long caching and nosniff, then caches by source id", async () => {
    const requests: { url: string; hosts: readonly string[] }[] = [];
    const app = buildApp({
      fetchBytes: async (fetchUrl, options) => {
        requests.push({ url: fetchUrl, hosts: options.allowedHosts });
        expect(options.maxBytes).toBe(SPORTS_ICON_MAX_BYTES);
        expect(options.timeoutMs).toBe(SPORTS_ICON_TIMEOUT_MS);
        expect(options.rejectOversizedResponses).toBe(true);
        return { ok: true, contentType: "text/plain", body: png, truncated: false };
      }
    });

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("image/png");
      expect(response.headers["cache-control"]).toBe("private, max-age=86400");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect([...response.rawPayload]).toEqual([...png]);
    }
    expect(requests).toEqual([{ url: "https://example.com/favicon.ico", hosts: ["example.com"] }]);
    await app.close();
  });

  it.each(accepted)(
    "serves %s bytes regardless of the declared content type",
    async (type, body) => {
      const app = buildApp({ fetchBytes: okFetch(body, "application/octet-stream") });
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe(type);
      await app.close();
    }
  );

  it.each(rejected)("treats %s as no icon", async (_label, body) => {
    const app = buildApp({ fetchBytes: okFetch(body, "image/x-icon") });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("falls back to the www host when the bare domain has no icon", async () => {
    const requests: string[] = [];
    const app = buildApp({
      fetchBytes: async (fetchUrl, options) => {
        requests.push(fetchUrl);
        expect(options.allowedHosts).toEqual([new URL(fetchUrl).hostname]);
        if (fetchUrl.startsWith("https://www.")) {
          return { ok: true, contentType: null, body: ico, truncated: false };
        }
        return { ok: false, reason: "http_error" };
      }
    });
    const response = await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("image/x-icon");
    expect(requests).toEqual([
      "https://example.com/favicon.ico",
      "https://www.example.com/favicon.ico"
    ]);
    await app.close();
  });

  it("rejects truncated bodies and caches the miss for an hour, then retries", async () => {
    let clock = Date.parse("2026-09-03T12:00:00.000Z");
    let fetches = 0;
    const app = buildApp({
      now: () => new Date(clock),
      fetchBytes: async () => {
        fetches += 1;
        // Both candidate hosts are truncated on the first request; the retry after expiry is whole.
        return { ok: true, contentType: "image/x-icon", body: ico, truncated: fetches <= 2 };
      }
    });

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(404);
    expect(fetches).toBe(2);

    clock += 60 * 60 * 1_000 + 1;
    expect((await app.inject({ method: "GET", url })).statusCode).toBe(200);
    expect(fetches).toBe(3);
    await app.close();
  });
});
