import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { createDatabase, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { GetWeatherUnitResponse } from "@moss/shared";
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

describe("weather unit preferences", () => {
  let appDb: Kysely<MossDatabase>;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    ownerCookie = await signUp("Owner", "owner.weather-unit@example.test");
    memberCookie = await signUp("Member", "member.weather-unit@example.test");
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("defaults to Fahrenheit without persisting a setting", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-unit",
      headers: { cookie: ownerCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<GetWeatherUnitResponse>()).toEqual({ unit: "imperial" });
  });

  it("persists imperial and returns it on the next read", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/weather-unit",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { unit: "metric" }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json<GetWeatherUnitResponse>()).toEqual({ unit: "metric" });

    const get = await server.inject({
      method: "GET",
      url: "/api/me/weather-unit",
      headers: { cookie: ownerCookie }
    });
    expect(get.json<GetWeatherUnitResponse>()).toEqual({ unit: "metric" });
  });

  it("keeps the preference isolated per user", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/weather-unit",
      headers: { cookie: memberCookie }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<GetWeatherUnitResponse>()).toEqual({ unit: "imperial" });
  });

  it("rejects an unsupported unit", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/me/weather-unit",
      headers: { cookie: ownerCookie, "content-type": "application/json" },
      payload: { unit: "kelvin" }
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await server.inject({ method: "GET", url: "/api/me/weather-unit" });
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
