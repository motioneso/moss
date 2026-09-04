import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ReverseWeatherLocationResponse, SearchWeatherLocationsResponse } from "@moss/shared";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function geocodeResponse(results: unknown[]): Response {
  return new Response(JSON.stringify({ results }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("weather location search routes", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let providerResponse = geocodeResponse([]);

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({
      appDb,
      boss,
      logger: false,
      fetchFn: async () => providerResponse
    });
    await server.ready();
    ownerCookie = await signUp("Owner", "owner.weather-search@example.test");
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("returns provider candidates for a unique place", async () => {
    providerResponse = geocodeResponse([
      {
        latitude: 32.7157,
        longitude: -117.1611,
        name: "San Diego",
        admin1: "California",
        country: "United States"
      }
    ]);
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/search?query=San%20Diego",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchWeatherLocationsResponse>().candidates).toEqual([
      { lat: 32.7157, lon: -117.1611, label: "San Diego, California, United States" }
    ]);
  });

  it("names the browser's coordinates through the reverse lookup without saving anything", async () => {
    providerResponse = new Response(
      JSON.stringify({
        address: { city: "San Diego", state: "California", country: "United States" }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/reverse?lat=32.7157&lon=-117.1611",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<ReverseWeatherLocationResponse>().location).toEqual({
      lat: 32.7157,
      lon: -117.1611,
      label: "San Diego, California, United States"
    });
    const saved = await server.inject({
      method: "GET",
      url: "/api/me/weather-location",
      headers: { cookie: ownerCookie }
    });
    expect(saved.json<{ location: unknown }>().location).toBeNull();
  });

  it("rejects out-of-range coordinates on the reverse lookup", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/reverse?lat=95&lon=0",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns ambiguous candidates without saving anything", async () => {
    providerResponse = geocodeResponse([
      {
        latitude: 39.7817,
        longitude: -89.6501,
        name: "Springfield",
        admin1: "Illinois",
        country: "United States"
      },
      {
        latitude: 37.2153,
        longitude: -93.2982,
        name: "Springfield",
        admin1: "Missouri",
        country: "United States"
      }
    ]);
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/search?query=Springfield",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchWeatherLocationsResponse>().candidates).toHaveLength(2);
  });

  it("returns no candidates for an unknown place", async () => {
    providerResponse = geocodeResponse([]);
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/search?query=Nowhereville",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<SearchWeatherLocationsResponse>()).toEqual({ candidates: [] });
  });

  it("returns 502 when the geocoding provider is unavailable", async () => {
    providerResponse = new Response("upstream down", { status: 503 });
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/search?query=San%20Diego",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: "Weather location search is temporarily unavailable" });
  });

  it("requires authentication", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-location/search?query=Paris"
    });
    expect(res.statusCode).toBe(401);
  });

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(res.statusCode).toBe(200);
    return cookieHeader(res.headers);
  }
});
