// external-modules/food/src/worker/registry.ts
//
// Food Phase 1 (#926, #1701): the ONE handler-key -> handler map, serving both the queue job
// (estimate.run) and every assistant-tool invocation (food.meals.*) — confirmed
// against finance's precedent (external-modules/finance/src/worker/registry.ts:28): one worker
// subprocess, one defineModuleWorker registry, a manifest assistantTools[].handler key is just
// another key in the same map a queue handler key lives in. Split out of index.ts because
// defineModuleWorker attaches a readline on stdin at import time (finance's same reasoning) —
// tests import this table, never index.ts.
//
// `storeFrom(ctx)` builds FoodStore fresh per call from ctx.db, never once at module load
// (FoodStore only exists inside a per-RPC-call ModuleWorkerContext) — job-search's
// src/worker/registry.ts pattern, not finance's ports-closure ToolFactory (which builds its
// closure once per process and does not fit a per-call-only store).
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import {
  createMealsCorrectHandler,
  createMealsDeleteHandler,
  createMealsListHandler,
  createMealsLogHandler,
  createMealsReestimateHandler,
  createMealsSummarizeHandler
} from "../tools/meals.js";
import { sqlStore } from "../store/sql.js";
import { runEstimate } from "./handlers/estimate.js";

export type Handler = (ctx: ModuleWorkerContext) => Promise<unknown>;

function storeFrom(ctx: ModuleWorkerContext) {
  return sqlStore(ctx.db);
}

export const HANDLERS: Readonly<Record<string, Handler>> = {
  "estimate.run": runEstimate,
  "meals.list": (ctx) => createMealsListHandler(storeFrom(ctx))(ctx),
  "meals.summarize": (ctx) => createMealsSummarizeHandler(storeFrom(ctx))(ctx),
  "meals.log": (ctx) => createMealsLogHandler(storeFrom(ctx))(ctx),
  "meals.correct": (ctx) => createMealsCorrectHandler(storeFrom(ctx))(ctx),
  "meals.reestimate": (ctx) => createMealsReestimateHandler(storeFrom(ctx))(ctx),
  "meals.delete": (ctx) => createMealsDeleteHandler(storeFrom(ctx))(ctx)
};
