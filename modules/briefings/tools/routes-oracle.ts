/** The old Briefings routes and real repositories, run on the disposable gate database. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import type { PgBoss } from "pg-boss";
import { PreferencesRepository } from "@moss/structured-state";
import { getBuiltInModuleManifests } from "@moss/module-registry";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { setMossErrorHandler } from "../../../apps/api/src/error-handling.js";
import { registerBriefingsRoutes } from "../../../packages/briefings/src/routes.js";

type Step = { method: "GET" | "PATCH" | "POST"; url: string; body?: unknown };

export async function routesOracle(
  actor: string,
  steps: readonly Step[],
  vars: Readonly<Record<string, string>> = {}
) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  setMossErrorHandler(server);
  // Schedule calls are recorded and answered as pg-boss would; the registered zone is unknown.
  const calls: { op: string; cron?: string; tz?: string; key?: string }[] = [];
  const boss = {
    schedule: async (
      _queue: string,
      cron: string,
      _data: unknown,
      options: { tz: string; key: string }
    ) => {
      calls.push({ op: "schedule", cron, tz: options.tz, key: options.key });
    },
    unschedule: async (_queue: string, key: string) => {
      calls.push({ op: "unschedule", key });
    },
    getSchedules: async () => []
  } as unknown as PgBoss;
  registerBriefingsRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "briefings-parity" }),
    dataContext: new DataContextRunner(db),
    listModuleManifests: () => getBuiltInModuleManifests(),
    boss,
    localePreferences: new PreferencesRepository()
  });
  try {
    const responses = [];
    const fill = (text: string) =>
      text.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? _m);
    for (const { method, url: template, body } of steps) {
      const url = fill(template);
      const result = await server.inject({
        method,
        url,
        ...(body === undefined
          ? {}
          : { payload: JSON.stringify(body), headers: { "content-type": "application/json" } })
      });
      responses.push({ status: result.statusCode, body: result.json() as unknown });
    }
    return { responses, calls };
  } finally {
    await server.close();
    await db.destroy();
  }
}

if (process.argv[1]?.endsWith("routes-oracle.ts")) {
  let input = "";
  for await (const chunk of process.stdin) input += String(chunk);
  const { actor, steps, vars }: { actor: string; steps: Step[]; vars?: Record<string, string> } =
    JSON.parse(input);
  console.log(JSON.stringify(await routesOracle(actor, steps, vars)));
}
