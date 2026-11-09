/** Production Calendar routes and real repositories on the disposable gate DB. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { AiRepository } from "../../../packages/ai/src/repository.js";
import { createDatabase, DataContextRunner, getMossDatabaseUrls } from "@moss/db";
import { registerCalendarRoutes } from "../../../packages/calendar/src/routes.js";
import { DayPlanRepository } from "../../../packages/calendar/src/day-plan-repository.js";

export async function readHttpOracle(actor: string, paths: readonly string[]) {
  return httpOracle(
    actor,
    paths.map((url) => ({ method: "GET" as const, url }))
  );
}

export async function httpOracle(
  actor: string,
  requests: readonly {
    method: "GET" | "PATCH" | "POST";
    url: string;
    body?: Record<string, unknown>;
  }[],
  tasks?: Readonly<Record<string, { ownerUserId: string; status: string; dueAt: string | null }>>
) {
  assert.equal(process.env.JARVIS_GATE_RUN, "1", "Use verify-gate");
  const db = createDatabase({ connectionString: getMossDatabaseUrls().app, maxConnections: 1 });
  const server = Fastify();
  registerCalendarRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "calendar-http-parity" }),
    // Preview task facts, when a caller supplies them: only the actor's own tasks are visible,
    // mirroring the actor-scoped public Tasks projection.
    ...(tasks
      ? {
          findTask: async (_scopedDb: unknown, taskId: string) => {
            const task = tasks[taskId];
            if (!task || task.ownerUserId !== actor) return undefined;
            return { status: task.status, due_at: task.dueAt };
          }
        }
      : {}),
    dataContext: new DataContextRunner(db),
    dayPlanRepository: new DayPlanRepository({
      findTask: async () => {
        throw new Error("Task projections are outside this read oracle");
      }
    }),
    // These public projections are not called by the three read contracts under test.
    findSourceRun: async () => undefined,
    findRun: async () => undefined,
    resolveTimeZone: async () => "UTC",
    calendarWritebackPolicy: {
      set: (db, module, family, tier) =>
        new AiRepository().setActionPolicy(db, module, family, tier)
    }
  });
  try {
    const responses = [];
    for (const { method, url, body } of requests) {
      const result = await server.inject({ method, url, payload: body });
      responses.push({ status: result.statusCode, body: result.json() as unknown });
    }
    return responses;
  } finally {
    await server.close();
    await db.destroy();
  }
}
