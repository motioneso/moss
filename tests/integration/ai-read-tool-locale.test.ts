import { afterAll, beforeAll, expect, it } from "vitest";
import Fastify from "fastify";
import { registerAiRoutes } from "@moss/ai";
import { DataContextRunner, createDatabase } from "@moss/db";
import type { MossModuleManifest } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
const db = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
const dataContext = new DataContextRunner(db);
const app = Fastify({ logger: false });
let actor: string = ids.userA;
beforeAll(async () => {
  await resetFoundationDatabase();
  await dataContext.withDataContext({ actorUserId: ids.userA }, (scope) =>
    new PreferencesRepository().upsert(scope, "locale", {
      timezone: "Pacific/Kiritimati",
      region: "en-US",
      dateFormat: "24"
    })
  );
  await dataContext.withDataContext({ actorUserId: ids.userB }, (scope) =>
    new PreferencesRepository().upsert(scope, "locale", {
      timezone: "Pacific/Honolulu",
      region: "en-US",
      dateFormat: "24"
    })
  );
  const module: MossModuleManifest = {
    id: "locale-probe",
    name: "Locale probe",
    version: "1.0.0",
    publisher: "Moss",
    lifecycle: "optional",
    compatibility: { jarv1s: "*" },
    assistantTools: [
      {
        name: "locale.read",
        description: "Synthetic date context",
        permissionId: "locale.read",
        risk: "read",
        execute: async (_scope, _input, context) => ({
          data: { timezone: context.localTimezone, localeTimezone: context.locale?.timezone }
        })
      }
    ]
  };
  app.after(() =>
    registerAiRoutes(app, {
      resolveAccessContext: async () => ({ actorUserId: actor }),
      dataContext,
      resolveActiveModules: async () => [module]
    })
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await db.destroy();
});
it("supplies each owner's timezone to REST read tools despite a caller-supplied timezone", async () => {
  for (const [id, timezone] of [
    [ids.userA, "Pacific/Kiritimati"],
    [ids.userB, "Pacific/Honolulu"]
  ]) {
    actor = id!;
    const response = await app.inject({
      method: "POST",
      url: "/api/ai/assistant-tools/locale.read/invoke",
      payload: { input: { localTimezone: "America/Los_Angeles" } }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().invocation.result).toEqual({ timezone, localeTimezone: timezone });
  }
});
