/** Production Calendar routes and real repositories on the disposable gate DB. */
import assert from "node:assert/strict";
import Fastify from "fastify";
import { PreferencesRepository } from "@moss/structured-state";
import { LOCALE_PREFERENCE_KEY, resolveEffectiveLocale } from "@moss/shared";
import { AiRepository } from "../../../packages/ai/src/repository.js";
import { createDatabase, DataContextRunner, getMossDatabaseUrls, type Task } from "@moss/db";
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
  const dataContext = new DataContextRunner(db);
  registerCalendarRoutes(server, {
    resolveAccessContext: async () => ({ actorUserId: actor, requestId: "calendar-http-parity" }),
    // Preview task facts, when a caller supplies them: only the actor's own tasks are visible,
    // mirroring the actor-scoped public Tasks projection.
    ...(tasks
      ? {
          findTask: async (_scopedDb: unknown, taskId: string): Promise<Task | undefined> => {
            const task = tasks[taskId];
            if (!task || task.ownerUserId !== actor) return undefined;
            return {
              id: taskId,
              owner_user_id: actor,
              list_id: taskId,
              parent_task_id: null,
              title: "Synthetic preview task",
              description: null,
              status: task.status === "done" || task.status === "archived" ? task.status : "todo",
              priority: null,
              position: 0,
              due_at: task.dueAt === null ? null : new Date(task.dueAt),
              do_at: null,
              completed_at: null,
              effort: null,
              source: "fixture",
              source_ref: null,
              external_key: null,
              recurrence: null,
              recurrence_series_id: null,
              suggestion_metadata: null,
              created_at: new Date("2026-11-08T00:00:00Z"),
              updated_at: new Date("2026-11-08T00:00:00Z")
            };
          }
        }
      : {}),
    dataContext,
    dayPlanRepository: new DayPlanRepository({
      findTask: async () => {
        throw new Error("Task projections are outside this HTTP oracle");
      }
    }),
    // Source-run and task enrichment are outside these scoped comparisons.
    findSourceRun: async () => undefined,
    findRun: async () => undefined,
    resolveTimeZone: async (access) => {
      const locale = await dataContext.withDataContext(access, (scopedDb) =>
        new PreferencesRepository().get(scopedDb, LOCALE_PREFERENCE_KEY)
      );
      return resolveEffectiveLocale(locale).timezone;
    },
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
