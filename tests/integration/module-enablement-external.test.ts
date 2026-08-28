// #1762: installed external modules in the personal Modules list. Split out of
// module-enablement.test.ts to stay under the 1000-line file-size gate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { getModuleDeletionTables } from "@moss/module-registry";
import { HttpError, type MossModuleManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";

import { registerSettingsRoutes } from "../../packages/settings/src/routes.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("installed external modules appear in the personal Modules list (#1762)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: FastifyInstance;

  const builtInManifest: MossModuleManifest = {
    id: "builtin-fixture",
    name: "Built-in Fixture",
    version: "0.1.0",
    publisher: "test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    availability: { defaultEnabled: true, required: false, supportsUserDisable: true }
  };

  function findModule(body: string, id: string) {
    const modules = (JSON.parse(body) as { modules: { id: string }[] }).modules;
    return modules.find((module) => module.id === id) as
      | (Record<string, unknown> & { id: string })
      | undefined;
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    server = Fastify({ logger: false });
    registerSettingsRoutes(server, {
      rootDb: appDb,
      dataContext,
      resolveAccessContext: async (request) => {
        const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
        if (token === ids.sessionA) return { actorUserId: ids.userA, requestId: "req:ext-1762" };
        throw new HttpError(401, "Unauthorized");
      },
      listModuleManifests: () => [builtInManifest],
      moduleDeletionTables: getModuleDeletionTables(),
      preferencesRepository: new PreferencesRepository(),
      // The port the composition root wires in apps/api. Deliberately not filtered by the actor's
      // own deny rows, so a module the user switched off keeps its row — and its switch.
      listInstalledExternalModules: async () => [
        {
          id: "ext-fixture",
          name: "Ext Fixture",
          version: "0.3.0",
          hasPreferences: true,
          hasUserCredentials: false,
          status: "enabled"
        }
      ]
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server.close(), appDb.destroy()]);
  });

  it("lists an installed external module alongside the built-ins", async () => {
    const response = await server.inject({
      method: "GET",
      url: "/api/me/modules",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(response.statusCode).toBe(200);
    // Before #1762 this endpoint enumerated built-in manifests only, so a downloaded module was
    // absent and every branch the pane has for one was unreachable.
    expect(findModule(response.body, "builtin-fixture")).toBeDefined();
    expect(findModule(response.body, "ext-fixture")).toMatchObject({
      name: "Ext Fixture",
      version: "0.3.0",
      required: false,
      supportsUserDisable: true,
      userDisabled: false,
      active: true,
      // The flag is what makes the pane render a Configure link at all.
      hasPreferences: true
    });
  });

  it("switching an external module off keeps it listed with its switch", async () => {
    const patch = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/ext-fixture",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { disabled: true }
    });
    // 404 here was the pre-#1762 behaviour: the route resolved ids against built-in manifests only.
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).module).toMatchObject({
      id: "ext-fixture",
      userDisabled: true,
      active: false
    });

    const list = await server.inject({
      method: "GET",
      url: "/api/me/modules",
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });
    expect(findModule(list.body, "ext-fixture")).toMatchObject({
      userDisabled: true,
      active: false
    });
  });

  it("switching it back on clears the deny row", async () => {
    const patch = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/ext-fixture",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { disabled: false }
    });
    expect(patch.statusCode).toBe(200);
    expect(JSON.parse(patch.body).module).toMatchObject({ userDisabled: false, active: true });
  });

  it("still 404s for an id that is neither built-in nor installed", async () => {
    const response = await server.inject({
      method: "PATCH",
      url: "/api/me/modules/not-a-module",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { disabled: true }
    });
    expect(response.statusCode).toBe(404);
  });
});
