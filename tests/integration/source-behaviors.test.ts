import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { getBuiltInModuleManifests, getModuleDeletionTables } from "@moss/module-registry";
import type { MossModuleManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const { Client } = pg;

function userHeaders(sessionId: string): Record<string, string> {
  return { authorization: `Bearer ${sessionId}` };
}

function userAHeaders(): Record<string, string> {
  return userHeaders(ids.sessionA);
}

function userBHeaders(): Record<string, string> {
  return userHeaders(ids.sessionB);
}

function testManifest(): MossModuleManifest {
  return {
    id: "test-source",
    name: "Test source",
    version: "0.0.0",
    publisher: "test",
    lifecycle: "required",
    compatibility: { jarv1s: ">=0.0.0" },
    sourceBehaviors: [
      {
        id: "test-source",
        name: "Test source",
        description: "Synthetic source behavior for integration coverage.",
        behaviors: [
          {
            id: "test-source.briefings",
            name: "Include in briefings",
            description: "Proves settings lists manifest-declared behaviors dynamically.",
            default: "default-off"
          }
        ]
      }
    ]
  };
}

async function clearPreferences(): Promise<void> {
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query("DELETE FROM app.preferences");
  } finally {
    await client.end();
  }
}

function findBehavior(body: unknown, behaviorId: string): Record<string, unknown> {
  const sources = (body as { sources?: Array<{ behaviors?: Record<string, unknown>[] }> }).sources;
  for (const source of sources ?? []) {
    const found = source.behaviors?.find((behavior) => behavior.id === behaviorId);
    if (found) return found;
  }
  throw new Error(`Missing behavior ${behaviorId}`);
}

describe("source behavior settings API", () => {
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
        if (token === ids.sessionA) return { actorUserId: ids.userA, requestId: "req:source-a" };
        if (token === ids.sessionB) return { actorUserId: ids.userB, requestId: "req:source-b" };
        throw new Error("unauthorized");
      },
      listModuleManifests: () => [...getBuiltInModuleManifests(), testManifest()],
      moduleDeletionTables: getModuleDeletionTables(),
      preferencesRepository: new PreferencesRepository()
    });
    await server.ready();
  });

  beforeEach(async () => {
    await clearPreferences();
  });

  afterAll(async () => {
    await Promise.allSettled([server.close(), appDb.destroy()]);
  });

  it("lists declared source behaviors with current per-user values", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/me/source-behaviors",
      headers: userAHeaders()
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect((body.sources as Array<{ id: string }>).map((source) => source.id)).toEqual([
      "calendar",
      "email",
      "people-notes",
      "test-source"
    ]);
    expect(findBehavior(body, "calendar.briefings")).toMatchObject({
      enabled: true,
      default: "default-on",
      toggleable: true
    });
    expect(findBehavior(body, "calendar.writeback")).toMatchObject({
      enabled: true,
      default: "default-on",
      toggleable: true
    });
    expect(findBehavior(body, "people.notes.suggest-updates")).toMatchObject({
      sourceId: "people-notes",
      enabled: true,
      default: "default-on",
      toggleable: true
    });
    expect(findBehavior(body, "test-source.briefings")).toMatchObject({
      sourceId: "test-source",
      enabled: false,
      default: "default-off",
      toggleable: true
    });
  });

  it("lets a non-admin set only their own live source-behavior toggles", async () => {
    const put = await server.inject({
      method: "PUT",
      url: "/api/me/source-behaviors/calendar.briefings",
      headers: userAHeaders(),
      payload: { enabled: false }
    });
    const userB = await server.inject({
      method: "GET",
      url: "/api/me/source-behaviors",
      headers: userBHeaders()
    });

    expect(put.statusCode).toBe(200);
    expect(findBehavior(put.json(), "calendar.briefings").enabled).toBe(false);
    expect(findBehavior(userB.json(), "calendar.briefings").enabled).toBe(true);
  });

  it("rejects coming-soon writes", async () => {
    const response = await server.inject({
      method: "PUT",
      url: "/api/me/source-behaviors/email.thread-summaries",
      headers: userAHeaders(),
      payload: { enabled: true }
    });

    expect(response.statusCode).toBe(422);
  });
});
