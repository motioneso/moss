import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { SportsStandingsPreferencesResponse } from "@moss/shared";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const value = headers["set-cookie"];
  const cookies = Array.isArray(value) ? value : value === undefined ? [] : [String(value)];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("sports standings preferences — owner isolation", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;

  async function signUp(name: string, email: string): Promise<string> {
    const response = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(response.statusCode).toBe(200);
    return cookieHeader(response.headers);
  }

  async function put(cookie: string, selectedCompetitionKeys: readonly string[]) {
    return server.inject({
      method: "PUT",
      url: "/api/sports/standings-preferences",
      headers: { cookie },
      payload: { selectedCompetitionKeys }
    });
  }

  async function get(cookie: string): Promise<SportsStandingsPreferencesResponse> {
    const response = await server.inject({
      method: "GET",
      url: "/api/sports/standings-preferences",
      headers: { cookie }
    });
    expect(response.statusCode).toBe(200);
    return response.json<SportsStandingsPreferencesResponse>();
  }

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("keeps each actor's list private, including from the instance admin", async () => {
    const admin = await signUp("Admin", "sports-standings-admin@example.test");
    const alice = await signUp("Alice", "sports-standings-alice@example.test");
    const bob = await signUp("Bob", "sports-standings-bob@example.test");

    expect((await put(admin, ["nba"])).statusCode).toBe(200);
    expect((await put(alice, ["eng.1", "nfl"])).statusCode).toBe(200);

    expect(await get(admin)).toEqual({ selectedCompetitionKeys: ["nba"] });
    expect(await get(alice)).toEqual({ selectedCompetitionKeys: ["nfl", "eng.1"] });
    expect(await get(bob)).toEqual({ selectedCompetitionKeys: null });
  });
});
