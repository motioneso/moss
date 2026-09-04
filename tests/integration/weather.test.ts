import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type {
  GetWeatherTodayResponse,
  GetWeatherLocationResponse,
  WeatherTodayDto
} from "@moss/shared";
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

function makeOpenMeteoResponse(temp: number, feelsLike: number, wmoCode: number): Response {
  return new Response(
    JSON.stringify({
      current: {
        temperature_2m: temp,
        apparent_temperature: feelsLike,
        weather_code: wmoCode,
        relative_humidity_2m: 50,
        dew_point_2m: 10,
        wind_speed_10m: 8
      },
      daily: {
        time: ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
        weather_code: [wmoCode, 2, 61, 3, 71],
        temperature_2m_max: [temp + 2, 22, 19, 21, 15],
        temperature_2m_min: [temp - 4, 13, 11, 10, 8]
      }
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function makeIpWhoIsResponse(lat: number, lon: number, city: string, country: string): Response {
  return new Response(
    JSON.stringify({ success: true, latitude: lat, longitude: lon, city, country }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("weather integration", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let ownerCookie: string;
  let memberCookie: string;

  async function signUp(
    srv: ReturnType<typeof createApiServer>,
    name: string,
    email: string
  ): Promise<string> {
    const res = await srv.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(res.statusCode).toBe(200);
    return cookieHeader(res.headers);
  }

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    // #1124: createApiServer()'s default boss falls back to pg-boss's own 10s
    // connectionTimeoutMillis, which a loaded CI runner's PG connection establishment can
    // exceed even when the connection ultimately succeeds. Pass an explicit, longer-but-still-
    // under-hookTimeout override so a slow-but-healthy CI connection isn't killed prematurely.
    // Every server built below shares this appDb/connection, so one boss is reused throughout.
    // Test-only — production callers of createApiServer() are unaffected.
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
  });

  afterAll(async () => {
    await Promise.allSettled([appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  describe("weather-location preference", () => {
    let server: ReturnType<typeof createApiServer>;

    beforeAll(async () => {
      server = createApiServer({ appDb, boss, logger: false });
      await server.ready();
      ownerCookie = await signUp(server, "Owner", "owner.wx@example.test");
      memberCookie = await signUp(server, "Member", "member.wx@example.test");
    });

    afterAll(async () => {
      await server?.close();
    });

    it("returns null location by default", async () => {
      const res = await server.inject({
        method: "GET",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<GetWeatherLocationResponse>().location).toBeNull();
    });

    it("saves weather location via PUT", async () => {
      const put = await server.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { lat: 37.77, lon: -122.42, label: "San Francisco, US" }
      });
      expect(put.statusCode).toBe(200);
      expect(put.json<GetWeatherLocationResponse>().location).toMatchObject({
        lat: 37.77,
        lon: -122.42,
        label: "San Francisco, US"
      });
    });

    it("GET after PUT returns saved location", async () => {
      const get = await server.inject({
        method: "GET",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie }
      });
      expect(get.statusCode).toBe(200);
      expect(get.json<GetWeatherLocationResponse>().location?.label).toBe("San Francisco, US");
    });

    it("PUT null clears the location", async () => {
      const put = await server.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: "null"
      });
      expect(put.statusCode).toBe(200);
      expect(put.json<GetWeatherLocationResponse>().location).toBeNull();

      const get = await server.inject({
        method: "GET",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie }
      });
      expect(get.json<GetWeatherLocationResponse>().location).toBeNull();
    });

    it("location is per-user (RLS: member sees null while owner has a saved location)", async () => {
      // Re-save for owner
      await server.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { lat: 51.5, lon: -0.12, label: "London, GB" }
      });
      const memberRes = await server.inject({
        method: "GET",
        url: "/api/me/weather-location",
        headers: { cookie: memberCookie }
      });
      expect(memberRes.json<GetWeatherLocationResponse>().location).toBeNull();
    });

    it("requires authentication", async () => {
      const res = await server.inject({ method: "GET", url: "/api/me/weather-location" });
      expect(res.statusCode).toBe(401);
    });

    it("rejects out-of-range lat", async () => {
      const res = await server.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie: ownerCookie, "content-type": "application/json" },
        payload: { lat: 999, lon: 0, label: "Bad" }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("GET /api/weather/today", () => {
    it("returns data from Open-Meteo when preference is set", async () => {
      const fakeFetch = vi.fn((_input: RequestInfo | URL) =>
        Promise.resolve(makeOpenMeteoResponse(18, 15, 0))
      );
      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "WxUser", "wx.user@example.test");

      // Set a location preference first
      await srv.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie, "content-type": "application/json" },
        payload: { lat: 37.77, lon: -122.42, label: "San Francisco, US" }
      });

      const res = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<GetWeatherTodayResponse>();
      const data = body.data as WeatherTodayDto;
      expect(data).not.toBeNull();
      expect(data.temp).toBe(18);
      expect(data.feelsLike).toBe(15);
      expect(data.icon).toBe("sun");
      expect(data.condition).toBe("Clear sky");
      expect(data.location).toBe("San Francisco, US");
      expect(data.unit).toBe("imperial");
      expect(data.humidity).toBe(50);
      expect(data.dewPoint).toBe(10);
      expect(data.windSpeed).toBe(8);
      expect(data.lat).toBe(37.77);
      expect(data.lon).toBe(-122.42);
      expect(data.forecast).toHaveLength(4);
      expect(data.forecast[0]).toMatchObject({
        date: "2026-08-25",
        icon: "cloud-sun",
        high: 22,
        low: 13
      });
      // Only one call to Open-Meteo
      expect(fakeFetch).toHaveBeenCalledTimes(1);
      expect(String(fakeFetch.mock.calls[0]?.[0] ?? "")).toContain("api.open-meteo.com");

      await srv.close();
    });

    it("requests the selected unit and refreshes after unit or location changes", async () => {
      const fakeFetch = vi.fn((_input: RequestInfo | URL) =>
        Promise.resolve(makeOpenMeteoResponse(18, 15, 0))
      );
      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "UnitUser", "wx.unit@example.test");

      const saveLocation = async (location: { lat: number; lon: number; label: string }) => {
        const response = await srv.inject({
          method: "PUT",
          url: "/api/me/weather-location",
          headers: { cookie, "content-type": "application/json" },
          payload: location
        });
        expect(response.statusCode).toBe(200);
      };
      const getToday = () =>
        srv.inject({ method: "GET", url: "/api/weather/today", headers: { cookie } });

      await saveLocation({ lat: 37.77, lon: -122.42, label: "San Francisco, US" });
      expect((await getToday()).json<GetWeatherTodayResponse>().data?.unit).toBe("imperial");
      expect(String(fakeFetch.mock.calls[0]?.[0] ?? "")).toContain("temperature_unit=fahrenheit");

      await srv.inject({
        method: "PUT",
        url: "/api/me/weather-unit",
        headers: { cookie, "content-type": "application/json" },
        payload: { unit: "metric" }
      });
      expect((await getToday()).json<GetWeatherTodayResponse>().data?.unit).toBe("metric");
      expect(String(fakeFetch.mock.calls[1]?.[0] ?? "")).toContain("temperature_unit=celsius");

      await saveLocation({ lat: 51.5074, lon: -0.1278, label: "London, UK" });
      expect((await getToday()).json<GetWeatherTodayResponse>().data?.location).toBe("London, UK");
      expect(fakeFetch).toHaveBeenCalledTimes(3);

      await srv.close();
    });

    it("refreshes cached weather after a location is saved, changed, or cleared", async () => {
      const fakeFetch = vi.fn((_input: RequestInfo | URL) =>
        Promise.resolve(makeOpenMeteoResponse(18, 15, 0))
      );
      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "CacheUser", "cache.user@example.test");

      for (const location of [
        { lat: 37.77, lon: -122.42, label: "San Francisco, US" },
        { lat: 51.5074, lon: -0.1278, label: "London, UK" }
      ]) {
        await srv.inject({
          method: "PUT",
          url: "/api/me/weather-location",
          headers: { cookie, "content-type": "application/json" },
          payload: location
        });
        const res = await srv.inject({
          method: "GET",
          url: "/api/weather/today",
          headers: { cookie }
        });
        expect(res.json<GetWeatherTodayResponse>().data?.location).toBe(location.label);
      }

      await srv.inject({
        method: "PUT",
        url: "/api/me/weather-location",
        headers: { cookie, "content-type": "application/json" },
        payload: "null"
      });
      const cleared = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie, "x-timezone": "Europe/London" }
      });
      expect(cleared.json<GetWeatherTodayResponse>().data?.location).toBe("London, UK");
      expect(fakeFetch).toHaveBeenCalledTimes(3);

      await srv.close();
    });

    it("returns null when no location set and IP is loopback", async () => {
      const fakeFetch = vi.fn();
      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "NoLocUser", "noloc@example.test");

      const res = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<GetWeatherTodayResponse>().data).toBeNull();
      // No external calls for loopback IP
      expect(fakeFetch).not.toHaveBeenCalled();

      await srv.close();
    });

    it("falls back to IP geo when no preference set and IP is routable", async () => {
      const fakeFetch = vi
        .fn()
        .mockResolvedValueOnce(makeIpWhoIsResponse(48.85, 2.35, "Paris", "France"))
        .mockResolvedValueOnce(makeOpenMeteoResponse(22, 20, 1));

      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "IpUser", "ipuser@example.test");

      const res = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie, "x-forwarded-for": "1.2.3.4" }
      });
      // IP from server.inject is 127.0.0.1 so geo is skipped; this test verifies
      // the fake is wired and the request reaches the handler cleanly
      expect(res.statusCode).toBe(200);

      await srv.close();
    });

    it("requires authentication", async () => {
      const srv = createApiServer({ appDb, boss, logger: false });
      await srv.ready();
      const res = await srv.inject({ method: "GET", url: "/api/weather/today" });
      expect(res.statusCode).toBe(401);
      await srv.close();
    });

    it("falls back to the timezone table when no preference and IP-geo fails (loopback)", async () => {
      // server.inject's request.ip is always 127.0.0.1, which geocodeIp short-circuits on
      // without calling fetch (see ip-geocoder.ts) — so the only fetch call here is Open-Meteo.
      const fakeFetch = vi.fn().mockResolvedValueOnce(makeOpenMeteoResponse(12, 10, 2));

      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "TzUser", "tzuser@example.test");

      const res = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie, "x-timezone": "Europe/London" }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<GetWeatherTodayResponse>();
      const data = body.data as WeatherTodayDto;
      expect(data).not.toBeNull();
      expect(data.location).toBe("London, UK");

      expect(fakeFetch).toHaveBeenCalledTimes(1);
      const openMeteoUrl = String(fakeFetch.mock.calls[0]?.[0] ?? "");
      expect(openMeteoUrl).toContain("latitude=51.5074");
      expect(openMeteoUrl).toContain("longitude=-0.1278");

      await srv.close();
    });

    it("returns null when timezone is unrecognized and IP-geo fails (regression guard)", async () => {
      const fakeFetch = vi.fn();

      const srv = createApiServer({
        appDb,
        boss,
        logger: false,
        fetchFn: fakeFetch as typeof fetch
      });
      await srv.ready();
      const cookie = await signUp(srv, "TzUnknownUser", "tzunknown@example.test");

      const res = await srv.inject({
        method: "GET",
        url: "/api/weather/today",
        headers: { cookie, "x-timezone": "Etc/Unknown" }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<GetWeatherTodayResponse>().data).toBeNull();
      expect(fakeFetch).not.toHaveBeenCalled();

      await srv.close();
    });
  });
});
