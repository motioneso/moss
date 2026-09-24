import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { DatasetClient } from "@moss/datasets";
import type { AccessContext, DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";

import {
  registerSportsRoutes,
  type SportsRoutesDependencies
} from "../../packages/sports/src/routes.js";

// Kept in sync with the private keys in routes.ts on purpose: the test drives the real route and
// asserts per-key writes, so the strings are part of the observable contract.
const SELECTED_KEY = "sports.standings_competition_keys";
const LAST_VIEWED_KEY = "sports.standings_last_viewed";

function makePreferences(initial: Record<string, unknown> = {}): PreferencesPort & {
  values: Map<string, unknown>;
  writes: Array<{ key: string; value: unknown }>;
} {
  const values = new Map<string, unknown>(Object.entries(initial));
  const writes: Array<{ key: string; value: unknown }> = [];
  return {
    values,
    writes,
    get: async (_db, key) => values.get(key) ?? null,
    getWithMetadata: async () => null,
    upsert: async (_db, key, next) => {
      values.set(key, next);
      writes.push({ key, value: next });
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
      setSourceTeamId: async () => undefined,
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
    ).toEqual({ selectedCompetitionKeys: null, lastViewed: null });
    await absent.close();

    const app = buildApp(
      makePreferences({ [SELECTED_KEY]: ["retired.league", "eng.1", "nfl", "nfl"] })
    );
    await app.ready();
    expect(
      (await app.inject({ method: "GET", url: "/api/sports/standings-preferences" })).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl", "eng.1"], lastViewed: null });
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
    ).toEqual({ selectedCompetitionKeys: ["nfl", "eng.1"], lastViewed: null });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sports/standings-preferences",
          payload: { selectedCompetitionKeys: [] }
        })
      ).json()
    ).toEqual({ selectedCompetitionKeys: [], lastViewed: null });
    expect(preferences.writes).toEqual([
      { key: SELECTED_KEY, value: ["nfl", "eng.1"] },
      { key: SELECTED_KEY, value: [] }
    ]);
    await app.close();
  });

  // #2661: the last-viewed competition is saved under its own key, so writing it never disturbs
  // the selected-league list and the other way round.
  it("remembers the last-viewed standings without touching the list", async () => {
    const preferences = makePreferences({ [SELECTED_KEY]: ["nfl"] });
    const app = buildApp(preferences);
    await app.ready();
    const lastViewed = {
      competitionKey: "fifa.wwc",
      viewKey: "sec:2",
      viewLabel: "Group B"
    };
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sports/standings-preferences",
          payload: { lastViewed }
        })
      ).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl"], lastViewed });
    expect(preferences.writes).toEqual([{ key: LAST_VIEWED_KEY, value: lastViewed }]);

    expect(
      (await app.inject({ method: "GET", url: "/api/sports/standings-preferences" })).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl"], lastViewed });

    // A null clears the remembered pick without removing the selected list.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/sports/standings-preferences",
          payload: { lastViewed: null }
        })
      ).json()
    ).toEqual({ selectedCompetitionKeys: ["nfl"], lastViewed: null });
    await app.close();
  });

  it("rejects malformed or unknown input before writing", async () => {
    const preferences = makePreferences();
    const app = buildApp(preferences);
    await app.ready();
    const payloads = [
      {},
      { selectedCompetitionKeys: "nfl" },
      { selectedCompetitionKeys: ["nfl"], extra: true },
      { selectedCompetitionKeys: ["nfl", "nfl"] },
      { selectedCompetitionKeys: Array.from({ length: 65 }, (_, index) => `league-${index}`) },
      { selectedCompetitionKeys: ["unknown.league"] },
      { lastViewed: { competitionKey: "unknown.league" } },
      { lastViewed: { competitionKey: "fifa.wwc", viewKey: 3 } },
      { lastViewed: { competitionKey: "", viewKey: null, viewLabel: null } }
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
