import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";

import {
  registerSportsRoutes,
  type SportsRoutesDependencies
} from "../../packages/sports/src/routes.js";

function makePreferences(initial: unknown = null): PreferencesPort & { writes: unknown[] } {
  let value = initial;
  const writes: unknown[] = [];
  return {
    writes,
    get: async () => value,
    getWithMetadata: async () => null,
    upsert: async (_db, _key, next) => {
      value = next;
      writes.push(next);
    }
  };
}

function buildApp(preferencesRepository: PreferencesPort) {
  const app = Fastify();
  const dataContext = {
    withDataContext: async <T>(_access: AccessContext, work: (db: DataContextDb) => Promise<T>) =>
      work({} as DataContextDb)
  } as unknown as DataContextRunner;
  registerSportsRoutes(app, {
    datasetClient: {
      getDataset: async <T>(
        _key: string,
        _params: Record<string, unknown>,
        options: { fallback: T }
      ) => ({ data: options.fallback, degraded: false, fetchedAt: new Date().toISOString() })
    } as DatasetClient,
    dataContext,
    resolveAccessContext: async () => ({ actorUserId: "actor-a", requestId: "request-a" }),
    repository: {
      list: async () => [],
      create: async () => {
        throw new Error("not used");
      },
      remove: async () => false
    },
    preferencesRepository,
    discovery: {
      fetch: async () => ({ ok: false, reason: "network" }),
      ai: {
        generateJson: async () => ({ ok: false, error: "needs_config" }),
        fingerprint: async () => null
      }
    } as SportsRoutesDependencies["discovery"],
    storyFeedback: {
      refFor: () => "sports:test-ref",
      registerStories: async () => undefined
    }
  });
  return app;
}

describe("sports standings preference routes", () => {
  it("distinguishes absent state and filters stored keys into catalog order", async () => {
    const absent = buildApp(makePreferences());
    await absent.ready();
    expect(
      (await absent.inject({ method: "GET", url: "/api/sports/standings-preferences" })).json()
    ).toEqual({ selectedCompetitionKeys: null });
    await absent.close();

    const app = buildApp(makePreferences(["retired.league", "eng.1", "nfl", "nfl"]));
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/api/sports/standings-preferences" })).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl", "eng.1"] });
    await app.close();
  });

  it("replaces the list atomically in catalog order, including explicit empty", async () => {
    const preferences = makePreferences();
    const app = buildApp(preferences);
    await app.ready();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sports/standings-preferences",
          payload: { selectedCompetitionKeys: ["eng.1", "nfl"] }
        })
      ).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl", "eng.1"] });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sports/standings-preferences",
          payload: { selectedCompetitionKeys: [] }
        })
      ).json()
    ).toEqual({ selectedCompetitionKeys: [] });
    expect(preferences.writes).toEqual([["nfl", "eng.1"], []]);
    await app.close();
  });

  it("rejects malformed or unknown input before writing", async () => {
    const preferences = makePreferences();
    const app = buildApp(preferences);
    await app.ready();
    const payloads = [
      { selectedCompetitionKeys: "nfl" },
      { selectedCompetitionKeys: ["nfl"], extra: true },
      { selectedCompetitionKeys: ["nfl", "nfl"] },
      { selectedCompetitionKeys: Array.from({ length: 65 }, (_, index) => `league-${index}`) },
      { selectedCompetitionKeys: ["unknown.league"] }
    ];
    for (const payload of payloads) {
      const response = await app.inject({
        method: "PUT",
        url: "/api/sports/standings-preferences",
        payload
      });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(preferences.writes).toEqual([]);
    await app.close();
  });
});
