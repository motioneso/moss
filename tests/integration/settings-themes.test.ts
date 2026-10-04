import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests, getModuleDeletionTables } from "@moss/module-registry";
import { HttpError } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import type {
  AestheticThemeTokens,
  ListThemesResponse,
  PutCustomThemeResponse
} from "@moss/shared";
import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const validThemeTokens: AestheticThemeTokens = {
  paper: "#fbfaf6",
  surface: "#ffffff",
  surface2: "#f5f3ed",
  surface3: "#edeae1",
  ink: "#292621",
  ink2: "#5b564d",
  ink3: "#8b8678",
  ink4: "#9a958a",
  line: "rgb(38, 34, 28)",
  lineSubtle: "rgb(245, 243, 237)",
  lineStrong: "rgb(210, 205, 194)",
  accent: "#2f6a4c"
};

function userHeaders(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

describe("settings theme preferences", () => {
  let appDb: Kysely<MossDatabase>;
  let server: FastifyInstance;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    const dataContext = new DataContextRunner(appDb);
    server = Fastify({ logger: false });
    registerSettingsRoutes(server, {
      rootDb: appDb,
      dataContext,
      resolveAccessContext: async (request) => {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token === ids.sessionA) return { actorUserId: ids.userA, requestId: "req:theme-a" };
        if (token === ids.sessionB) return { actorUserId: ids.userB, requestId: "req:theme-b" };
        throw new HttpError(401, "Unauthorized");
      },
      listModuleManifests: () => getBuiltInModuleManifests(),
      moduleDeletionTables: getModuleDeletionTables(),
      preferencesRepository: new PreferencesRepository()
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
  });

  it("returns built-in themes and default active light theme", async () => {
    const res = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: userHeaders(ids.sessionA)
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<ListThemesResponse>()).toEqual({
      builtIn: [
        { id: "light", name: "Forest", builtIn: true },
        { id: "sage", name: "Sage", builtIn: true },
        { id: "canyon", name: "Canyon", builtIn: true },
        { id: "teal", name: "Teal", builtIn: true },
        { id: "dusk", name: "Dusk", builtIn: true }
      ],
      custom: [],
      activeId: "light",
      mode: "light"
    });
  });

  it("creates a custom theme and keeps semantic tokens out of storage", async () => {
    const put = await putTheme(ids.sessionA, "my-blue", {
      name: "My Blue",
      tokens: { ...validThemeTokens, red: "#000000" } as unknown as AestheticThemeTokens
    });

    expect(put.statusCode).toBe(200);
    const theme = put.json<PutCustomThemeResponse>().theme;
    expect(theme).toMatchObject({ id: "my-blue", name: "My Blue", builtIn: false });
    expect(theme.tokens).toEqual(validThemeTokens);
    expect(Object.keys(await readPreference("themes.custom"))).not.toContain("red");
  });

  it("persists the optional gold token when provided", async () => {
    const put = await putTheme(ids.sessionA, "gold-theme", {
      name: "Golden",
      tokens: { ...validThemeTokens, gold: "#c2872b" }
    });

    expect(put.statusCode).toBe(200);
    expect(put.json<PutCustomThemeResponse>().theme.tokens.gold).toBe("#c2872b");

    const list = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: userHeaders(ids.sessionA)
    });
    const stored = list
      .json<ListThemesResponse>()
      .custom.find((theme) => theme.id === "gold-theme");
    expect(stored?.tokens.gold).toBe("#c2872b");
  });

  it("persists the optional nav token when provided", async () => {
    const put = await putTheme(ids.sessionA, "nav-theme", {
      name: "Harbor",
      tokens: { ...validThemeTokens, nav: "#1f3a5f" }
    });

    expect(put.statusCode).toBe(200);
    expect(put.json<PutCustomThemeResponse>().theme.tokens.nav).toBe("#1f3a5f");

    const list = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: userHeaders(ids.sessionA)
    });
    const stored = list.json<ListThemesResponse>().custom.find((theme) => theme.id === "nav-theme");
    expect(stored?.tokens.nav).toBe("#1f3a5f");
  });

  it("persists active custom theme per user", async () => {
    await putTheme(ids.sessionA, "my-blue", { name: "My Blue", tokens: validThemeTokens });
    const active = await setActive(ids.sessionA, "my-blue");

    expect(active.statusCode).toBe(200);
    expect(active.json<ListThemesResponse>().activeId).toBe("my-blue");

    const memberRead = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: userHeaders(ids.sessionB)
    });

    expect(memberRead.statusCode).toBe(200);
    expect(memberRead.json<ListThemesResponse>().activeId).toBe("light");
  });

  it("rejects invalid colors", async () => {
    const res = await putTheme(ids.sessionA, "bad", {
      name: "Bad",
      tokens: { ...validThemeTokens, accent: "url(javascript:alert(1))" }
    });

    expect(res.statusCode).toBe(400);
  });

  it("does not delete built-ins or the active theme", async () => {
    const builtInDelete = await server.inject({
      method: "DELETE",
      url: "/api/me/themes/light",
      headers: userHeaders(ids.sessionA)
    });
    await putTheme(ids.sessionA, "my-blue", { name: "My Blue", tokens: validThemeTokens });
    await setActive(ids.sessionA, "my-blue");
    const activeDelete = await server.inject({
      method: "DELETE",
      url: "/api/me/themes/my-blue",
      headers: userHeaders(ids.sessionA)
    });

    expect(builtInDelete.statusCode).toBe(400);
    expect(activeDelete.statusCode).toBe(400);
  });

  it("deletes inactive custom themes", async () => {
    await putTheme(ids.sessionA, "delete-me", { name: "Delete Me", tokens: validThemeTokens });
    const deleted = await server.inject({
      method: "DELETE",
      url: "/api/me/themes/delete-me",
      headers: userHeaders(ids.sessionA)
    });
    const list = await server.inject({
      method: "GET",
      url: "/api/me/themes",
      headers: userHeaders(ids.sessionA)
    });

    expect(deleted.statusCode).toBe(200);
    expect(list.json<ListThemesResponse>().custom.some((theme) => theme.id === "delete-me")).toBe(
      false
    );
  });

  it("requires authentication", async () => {
    const res = await server.inject({ method: "GET", url: "/api/me/themes" });

    expect(res.statusCode).toBe(401);
  });

  async function putTheme(sessionId: string, id: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "PUT",
      url: `/api/me/themes/${id}`,
      headers: { ...userHeaders(sessionId), "content-type": "application/json" },
      payload
    });
  }

  async function setActive(sessionId: string, id: string) {
    return server.inject({
      method: "PUT",
      url: "/api/me/themes/active",
      headers: { ...userHeaders(sessionId), "content-type": "application/json" },
      payload: { id }
    });
  }

  async function readPreference(key: string): Promise<Record<string, unknown>> {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const result = await client.query(
        "SELECT value_json FROM app.preferences WHERE owner_user_id = $1 AND key = $2 ORDER BY updated_at DESC LIMIT 1",
        [ids.userA, key]
      );
      return (result.rows[0]?.value_json ?? {}) as Record<string, unknown>;
    } finally {
      await client.end();
    }
  }
});
