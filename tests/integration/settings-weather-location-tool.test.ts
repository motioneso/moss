import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { weatherLocationSetExecute } from "../../packages/settings/src/weather-location-tool.js";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const WEATHER_LOCATION_PREFERENCE_KEY = "weather-location";

function toolCtx(actorUserId: string): ToolContext {
  return { actorUserId, requestId: "req:weather-location-tool-test", chatSessionId: "" };
}

function stubGeocodeResponse(results: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ results })
    }))
  );
}

describe("settings.weatherLocation.set tool", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const preferences = new PreferencesRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb?.destroy();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("saves the single matching place and returns its coordinates", async () => {
    stubGeocodeResponse([
      {
        latitude: 39.7392,
        longitude: -104.9903,
        name: "Denver",
        admin1: "Colorado",
        country: "United States"
      }
    ]);

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:weather-a" },
      (scopedDb) => weatherLocationSetExecute(scopedDb, { query: "Denver" }, toolCtx(ids.userA))
    );
    expect(result.data).toEqual({
      status: "saved",
      lat: 39.7392,
      lon: -104.9903,
      label: "Denver, Colorado, United States"
    });

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:weather-a-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, WEATHER_LOCATION_PREFERENCE_KEY)
    );
    expect(stored?.value).toEqual({
      lat: 39.7392,
      lon: -104.9903,
      label: "Denver, Colorado, United States"
    });
    expect(stored?.revision).toBe(1);
  });

  it("returns candidates without writing when the place name is ambiguous", async () => {
    stubGeocodeResponse([
      {
        latitude: 39.8,
        longitude: -89.6,
        name: "Springfield",
        admin1: "Illinois",
        country: "United States"
      },
      {
        latitude: 37.2,
        longitude: -93.3,
        name: "Springfield",
        admin1: "Missouri",
        country: "United States"
      }
    ]);

    const result = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:weather-ambiguous" },
      (scopedDb) =>
        weatherLocationSetExecute(scopedDb, { query: "Springfield" }, toolCtx(ids.userB))
    );
    expect(result.data).toEqual({
      status: "ambiguous",
      candidates: [
        { lat: 39.8, lon: -89.6, label: "Springfield, Illinois, United States" },
        { lat: 37.2, lon: -93.3, label: "Springfield, Missouri, United States" }
      ]
    });

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:weather-ambiguous-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, WEATHER_LOCATION_PREFERENCE_KEY)
    );
    expect(stored).toBeNull();
  });

  it("throws and writes nothing when no place matches the query", async () => {
    stubGeocodeResponse([]);

    await expect(
      dataContext.withDataContext(
        { actorUserId: ids.adminUser, requestId: "req:weather-no-match" },
        (scopedDb) =>
          weatherLocationSetExecute(scopedDb, { query: "Nowhereville" }, toolCtx(ids.adminUser))
      )
    ).rejects.toThrow();

    const stored = await dataContext.withDataContext(
      { actorUserId: ids.adminUser, requestId: "req:weather-no-match-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, WEATHER_LOCATION_PREFERENCE_KEY)
    );
    expect(stored).toBeNull();
  });

  it("scopes the saved location to the acting user only", async () => {
    stubGeocodeResponse([
      { latitude: 51.5, longitude: -0.12, name: "London", country: "United Kingdom" }
    ]);
    await dataContext.withDataContext(
      { actorUserId: ids.userA, requestId: "req:weather-scope-a" },
      (scopedDb) => weatherLocationSetExecute(scopedDb, { query: "London" }, toolCtx(ids.userA))
    );

    const otherUser = await dataContext.withDataContext(
      { actorUserId: ids.userB, requestId: "req:weather-scope-b-read" },
      (scopedDb) => preferences.getWithRevision(scopedDb, WEATHER_LOCATION_PREFERENCE_KEY)
    );
    expect(otherUser).toBeNull();
  });
});
