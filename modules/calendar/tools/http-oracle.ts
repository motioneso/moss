/** Original Calendar read routes, real repositories and RLS on the disposable gate DB. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { registerCalendarRoutes } from "../../../packages/calendar/src/routes.js";
import { DayPlanRepository } from "../../../packages/calendar/src/day-plan-repository.js";

export async function readHttpOracle(actor: string, paths: readonly string[]) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  registerCalendarRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "calendar-http-parity" }),
    dataContext: new DataContextRunner(db),
    dayPlanRepository: new DayPlanRepository({
      findTask: async () => {
        throw new Error("Task projections are outside this read oracle");
      }
    }),
    // These public projections are not called by the three read contracts under test.
    findSourceRun: async () => undefined,
    findRun: async () => undefined,
    resolveTimeZone: async () => "UTC"
  });
  try {
    return await Promise.all(
      paths.map(async (url) => {
        const result = await server.inject({ method: "GET", url });
        return { status: result.statusCode, body: result.json() as unknown };
      })
    );
  } finally {
    await server.close();
    await db.destroy();
  }
}
