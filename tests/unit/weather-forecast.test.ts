import { describe, expect, it, vi } from "vitest";
import type { PreferencesPort } from "@moss/db";
import { VisualPresentationService } from "../../packages/chat/src/visual/presentation-service.js";
import { fetchIntervalForecast } from "../../packages/weather/src/forecast/provider.js";
import {
  selectForecastWindow,
  forecastWindowSlots,
  HOUR_MS
} from "../../packages/weather/src/forecast/window.js";
import { WeatherForecastReader } from "../../packages/weather/src/forecast/reader.js";
import { readWeatherForecastSnapshot } from "../../packages/weather/src/forecast/contract.js";
import {
  configureWeatherForecastRead,
  weatherForecastExecute
} from "../../packages/weather/src/forecast/tool.js";
import { makeRecordingDb } from "./helpers/recording-db.js";
import { admissionFixture } from "./helpers/gateway-admission-fixture.js";
import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  forecastSnapshot,
  hourlyPayload,
  intervalSource,
  weatherIntervals,
  weatherNow,
  weatherPlace
} from "../fixtures/weather-forecast.js";

const scoped = makeRecordingDb().scoped;
function harness() {
  let now = new Date(weatherNow);
  const values = new Map<string, unknown>([
    ["weather-location", weatherPlace.location],
    ["weather-unit", "imperial"],
    ["locale", { timezone: "Asia/Tokyo" }]
  ]);
  const preferences: PreferencesPort = {
    get: vi.fn(async (_db, key) => values.get(key) ?? null),
    getWithMetadata: vi.fn(),
    upsert: vi.fn()
  };
  let payload: unknown = hourlyPayload();
  const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
  const reader = new WeatherForecastReader(preferences, fetchFn, () => now);
  return {
    reader,
    preferences,
    values,
    fetchFn,
    setPayload: (v: unknown) => {
      payload = v;
    },
    setNow: (v: Date) => {
      now = v;
    }
  };
}
describe("Weather provider and local windows", () => {
  it("uses the forecast place's date at the UTC boundary rather than the actor or server zone", () => {
    const now = new Date("2026-10-24T01:00:00Z");
    const forecast = selectForecastWindow(
      intervalSource({ intervals: weatherIntervals("2026-10-23") }),
      weatherPlace,
      {},
      now
    )!;
    expect(forecast.localDate).toBe("2026-10-23");
    expect(forecast.requestedStart).toBe("2026-10-24T01:00:00.000Z");
    expect(forecast.requestedEnd).toBe("2026-10-24T05:00:00.000Z");
    expect(forecast.coverage).toBe("complete");
    expect(forecast.intervals).toHaveLength(4);
  });
  it("counts real DST gap/fold hours and preserves distinct offsets", () => {
    const spring = forecastWindowSlots("2026-03-08", "America/New_York", 0, 4);
    const fall = forecastWindowSlots("2026-11-01", "America/New_York", 0, 4);
    expect(spring.map((v) => new Date(v).toISOString())).toEqual([
      "2026-03-08T05:00:00.000Z",
      "2026-03-08T06:00:00.000Z",
      "2026-03-08T07:00:00.000Z"
    ]);
    expect(fall).toHaveLength(5);
    expect(fall[2]! - fall[1]!).toBe(HOUR_MS);
    const source = intervalSource({
      timeZone: "America/New_York",
      intervals: weatherIntervals("2026-11-01", "America/New_York", 0, 4)
    });
    expect(
      selectForecastWindow(
        source,
        weatherPlace,
        { startHour: 0, endHour: 4 },
        new Date("2026-11-01T12:00:00Z")
      )?.coverage
    ).toBe("complete");
  });
  it("does not fill missing hours, include another day, or claim complete coverage from bounds", () => {
    const intervals = weatherIntervals();
    const partial = selectForecastWindow(
      intervalSource({
        intervals: [intervals[3]!, intervals[0]!, ...weatherIntervals("2026-10-25")]
      }),
      weatherPlace,
      {},
      weatherNow
    )!;
    expect(partial.coverage).toBe("partial");
    expect(partial.intervals.map((v) => v.temperature)).toEqual([60, 57]);
    expect(
      selectForecastWindow(intervalSource({ intervals: [] }), weatherPlace, {}, weatherNow)
        ?.coverage
    ).toBe("missing");
    expect(
      selectForecastWindow(intervalSource({ timeZone: "Made/Up" }), weatherPlace, {}, weatherNow)
    ).toBeNull();
    expect(
      selectForecastWindow(
        intervalSource(),
        weatherPlace,
        { startHour: 0, endHour: 24 },
        weatherNow
      )
    ).toBeNull();
  });
  it("marks stale records and approximate fallbacks without relabeling source timestamps", () => {
    const value = selectForecastWindow(
      intervalSource({ retrievedAt: "2026-10-24T08:00:00.000Z" }),
      { ...weatherPlace, source: "timezone-fallback" },
      {},
      weatherNow
    )!;
    expect(value.stale).toBe(true);
    expect(value.approximate).toBe(true);
    expect(value.retrievedAt).toBe("2026-10-24T08:00:00.000Z");
  });
  it.each(["imperial", "metric"] as const)(
    "requests and validates %s units, preserving unsupported rain/wind as unknown",
    async (unit) => {
      const payload = hourlyPayload();
      payload.hourly_units.temperature_2m = unit === "metric" ? "°C" : "°F";
      payload.hourly_units.wind_speed_10m = "unsupported";
      payload.hourly_units.precipitation_probability = "unsupported";
      const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
      const read = await fetchIntervalForecast(1, 2, unit, fetchFn, () => weatherNow);
      expect(new URL(String(fetchFn.mock.calls[0]![0])).searchParams.get("temperature_unit")).toBe(
        unit === "metric" ? "celsius" : "fahrenheit"
      );
      expect(read.intervals[0]).toMatchObject({
        temperature: 60,
        rainProbability: null,
        windSpeed: null
      });
      expect(read.windUnit).toBe(unit === "metric" ? "km/h" : "mph");
      payload.hourly_units.temperature_2m = "wrong";
      await expect(fetchIntervalForecast(1, 2, unit, fetchFn, () => weatherNow)).rejects.toThrow(
        "units"
      );
    }
  );
  it("rejects malformed, duplicate and unsupported fields without inventing zeroes", async () => {
    const payload = hourlyPayload();
    payload.hourly.time[1] = payload.hourly.time[0]!;
    payload.hourly.precipitation_probability[2] = 101;
    payload.hourly.wind_speed_10m[2] = -1;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload)));
    const source = await fetchIntervalForecast(1, 2, "imperial", fetchFn, () => weatherNow);
    expect(source.intervals).toHaveLength(2);
    expect(source.intervals[0]).toMatchObject({ rainProbability: null, windSpeed: null });
    payload.timezone = "Unknown/Place";
    await expect(
      fetchIntervalForecast(1, 2, "imperial", fetchFn, () => weatherNow)
    ).rejects.toThrow("time zone");
  });
});
describe("authorized Weather reads and snapshots", () => {
  it("does not read preferences or fetch when the session denies Weather or the module is absent", async () => {
    const h = harness();
    configureWeatherForecastRead(h.reader);
    const modules = getBuiltInModuleManifests().filter((module) => module.id === "weather");
    const gateway = admissionFixture([], {
      deps: { resolveActiveModules: async () => modules }
    });
    const denied = gateway.tokens.mint({
      actorUserId: "actor-a",
      threadId: "thread-a",
      chatSessionId: "actor-a:chat",
      allowedToolNames: new Set()
    });
    expect(await gateway.gateway.callTool(denied, "weather.forecast", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("not in session allowlist")
    });
    const absent = admissionFixture([], { deps: { resolveActiveModules: async () => [] } });
    expect(await absent.gateway.callTool(absent.token, "weather.forecast", {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("not available")
    });
    expect(h.preferences.get).not.toHaveBeenCalled();
    expect(h.fetchFn).not.toHaveBeenCalled();
    const allowed = admissionFixture([], {
      deps: {
        resolveActiveModules: async () => modules,
        runner: {
          withDataContext: async (_access: unknown, callback: (db: typeof scoped) => unknown) =>
            callback(scoped)
        } as never
      }
    });
    expect(await allowed.gateway.callTool(allowed.token, "weather.forecast", {})).toMatchObject({
      ok: true
    });
    expect(h.fetchFn).toHaveBeenCalledOnce();
  });
  it("returns the narrower current/daily outlook when hourly data is unavailable", async () => {
    const h = harness();
    h.fetchFn.mockImplementation(async (url) => {
      if (new URL(String(url)).searchParams.has("hourly"))
        return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify({
          current: {
            temperature_2m: 61,
            apparent_temperature: 60,
            weather_code: 2,
            relative_humidity_2m: 70,
            dew_point_2m: 45,
            wind_speed_10m: 8
          },
          daily: {
            time: ["2026-10-24", "2026-10-25"],
            weather_code: [2, 3],
            temperature_2m_max: [65, 66],
            temperature_2m_min: [52, 53]
          }
        })
      );
    });
    const result = await h.reader.read(scoped, "actor", {});
    expect(result).toMatchObject({
      status: "unavailable",
      outlook: {
        temp: 61,
        today: { high: 65, low: 52 },
        forecast: [{ date: "2026-10-25", high: 66, low: 53 }]
      }
    });
    expect(result).not.toHaveProperty("forecast.intervals");
  });
  it("reads actor preferences once per call, separates actor/unit/place cache and refreshes explicitly", async () => {
    const h = harness();
    const first = await h.reader.read(scoped, "actor", {});
    expect(first.status).toBe("forecast");
    if (first.status !== "forecast") throw new Error("missing forecast");
    expect(first.forecast).toMatchObject({
      unit: "imperial",
      timeZone: "America/Los_Angeles",
      approximate: false
    });
    h.setNow(new Date(weatherNow.getTime() + 60_000));
    expect(await h.reader.read(scoped, "actor", {})).toEqual(first);
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
    await h.reader.read(scoped, "actor", { refresh: true });
    expect(h.fetchFn).toHaveBeenCalledTimes(2);
    await h.reader.read(scoped, "other-actor", {});
    expect(h.fetchFn).toHaveBeenCalledTimes(3);
    h.values.set("weather-unit", "metric");
    const metric = hourlyPayload();
    metric.hourly_units.temperature_2m = "°C";
    metric.hourly_units.wind_speed_10m = "km/h";
    h.setPayload(metric);
    await h.reader.read(scoped, "actor", {});
    expect(h.fetchFn).toHaveBeenCalledTimes(4);
    h.values.set("weather-location", { ...weatherPlace.location, lat: 1 });
    await h.reader.read(scoped, "actor", {});
    expect(h.fetchFn).toHaveBeenCalledTimes(5);
    expect(h.preferences.upsert).not.toHaveBeenCalled();
  });
  it("labels a saved-zone fallback approximate, and never guesses a place from unsaved locale defaults", async () => {
    const h = harness();
    h.values.delete("weather-location");
    const read = await h.reader.read(scoped, "actor", {});
    expect(read).toMatchObject({
      status: "forecast",
      forecast: { approximate: true, place: "Tokyo, Japan", timeZone: "America/Los_Angeles" }
    });
    // The provider zone, not the guessed city label, remains authoritative even in this fixture.
    h.values.delete("locale");
    expect(await h.reader.read(scoped, "actor", {})).toMatchObject({ status: "unresolved" });
  });
  it("requires ambiguous-place clarification and accepts a qualified conversational correction without writes", async () => {
    const h = harness();
    const cities = {
      results: [
        {
          name: "Springfield",
          admin1: "Illinois",
          country: "United States",
          latitude: 39,
          longitude: -89
        },
        {
          name: "Springfield",
          admin1: "Oregon",
          country: "United States",
          latitude: 44,
          longitude: -123
        }
      ]
    };
    h.fetchFn.mockImplementation(
      async (url) =>
        new Response(JSON.stringify(String(url).includes("geocoding") ? cities : hourlyPayload()))
    );
    expect(await h.reader.read(scoped, "actor", { place: "Springfield" })).toMatchObject({
      status: "ambiguous",
      candidates: expect.any(Array)
    });
    const corrected = await h.reader.read(scoped, "actor", { place: "Springfield, Oregon" });
    expect(corrected).toMatchObject({
      status: "forecast",
      forecast: {
        place: "Springfield, Oregon, United States",
        locationSource: "conversation",
        approximate: false
      }
    });
    expect(h.values.get("weather-location")).toEqual(weatherPlace.location);
    expect(h.preferences.upsert).not.toHaveBeenCalled();
  });
  it("returns missing coverage without fabricating intervals or registering a card", async () => {
    const h = harness();
    const payload = hourlyPayload();
    payload.hourly.time = [];
    h.setPayload(payload);
    configureWeatherForecastRead(h.reader);
    const registerSnapshot = vi.fn();
    const result = await weatherForecastExecute(
      scoped,
      {},
      { actorUserId: "actor", requestId: "request", chatSessionId: "session" },
      { visualPresentation: { registerSnapshot } }
    );
    expect(result.data).toMatchObject({
      status: "forecast",
      forecast: { coverage: "missing", intervals: [] }
    });
    expect(registerSnapshot).not.toHaveBeenCalled();
  });
  it("registers only current-turn facts, rejects forgery/foreign context and discards after cancellation", async () => {
    const h = harness();
    configureWeatherForecastRead(h.reader);
    const service = new VisualPresentationService();
    const identity = { actorUserId: "actor", threadId: "thread", turnId: "turn" };
    const ctx = { ...identity, requestId: "test", chatSessionId: "session" };
    const turn = service.begin("session", identity);
    const result = await weatherForecastExecute(scoped, {}, ctx, { visualPresentation: service });
    expect(turn.reply).toBeUndefined();
    const presentation = result.data.presentation as {
      proposal: {
        catalogVersion: string;
        blocks: { kind: string; snapshotRefs: string[] }[];
        interactions: [];
      };
    };
    expect(presentation.proposal.blocks[0]?.kind).toBe("weather.forecast");
    const foreign = service.present({ ...ctx, threadId: "other" }, presentation.proposal);
    expect(foreign.ok).toBe(false);
    const presented = service.present(ctx, presentation.proposal);
    expect(presented.ok).toBe(true);
    if (presented.ok) {
      const snapshot = presented.reply.snapshots[0]!;
      expect(readWeatherForecastSnapshot(snapshot)?.intervals).toHaveLength(4);
      expect(presented.reply.fallbackText).toContain("Open-Meteo");
      const original = structuredClone(snapshot);
      h.setPayload({});
      expect(snapshot).toEqual(original);
    }
    turn.close();
    expect(turn.reply).toBeUndefined();
    expect(service.registerSnapshot(ctx, forecastSnapshot()).ok).toBe(false);
    const fresh = service.begin("other-session", { ...identity, turnId: "fresh" });
    const badCtx = { ...ctx, chatSessionId: "other-session", turnId: "fresh" };
    expect(
      service.present(badCtx, {
        ...presentation.proposal,
        blocks: [{ kind: "weather.forecast", snapshotRefs: ["forged"] }]
      }).ok
    ).toBe(false);
    fresh.close();
  });
  it.each(["source", "temperature", "window", "coverage", "zone", "extra"])(
    "rejects malformed %s snapshots",
    (change) => {
      const snapshot = forecastSnapshot();
      if (change === "source") snapshot.source.id = "forged";
      if (change === "temperature") snapshot.fields.intervals[0]!.temperature = NaN;
      if (change === "window") snapshot.fields.requestedStart = "2026-10-24T01:00:00.000Z";
      if (change === "coverage") snapshot.coverage = "All rain guaranteed";
      if (change === "zone") snapshot.fields.timeZone = "Unknown/Place";
      if (change === "extra") Object.assign(snapshot.fields, { remoteUrl: "https://example.org" });
      expect(readWeatherForecastSnapshot(snapshot)).toBeNull();
    }
  );
});
