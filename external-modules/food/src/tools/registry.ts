// external-modules/food/src/tools/registry.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 4): a side-effect-free map from every handler name
// this task's tools contribute to the function that serves it — job-search's
// src/worker/registry.ts pattern. `storeFrom(ctx)` builds FoodStore fresh per call from ctx.db,
// never once at module load (FoodStore only exists inside a per-RPC-call ModuleWorkerContext).
//
// worker.ts (Task 5, out of this task's scope) registers ONLY "estimate.run" today and notes
// that food.meals.log etc. need to be merged into its `defineModuleWorker({handlers: {...}})`
// call to be reachable at all — that merge is `{...FOOD_TOOL_HANDLERS, "estimate.run": runEstimate}`
// in worker.ts, a follow-up wiring step this task does not perform (src/worker.ts is off limits
// here). Keys below are handler names exactly as jarvis.module.json's assistantTools[].handler
// spells them — never the food.-prefixed tool NAME.
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import {
  createMealsCorrectHandler,
  createMealsDeleteHandler,
  createMealsListHandler,
  createMealsLogHandler,
  createMealsSummarizeHandler
} from "./meals.js";
import { sqlStore } from "../store/sql.js";

export type CtxHandler = (ctx: ModuleWorkerContext) => Promise<unknown>;

function storeFrom(ctx: ModuleWorkerContext) {
  return sqlStore(ctx.db);
}

export const FOOD_TOOL_HANDLERS: Readonly<Record<string, CtxHandler>> = {
  "meals.list": (ctx) => createMealsListHandler(storeFrom(ctx))(ctx),
  "meals.summarize": (ctx) => createMealsSummarizeHandler(storeFrom(ctx))(ctx),
  "meals.log": (ctx) => createMealsLogHandler(storeFrom(ctx))(ctx),
  "meals.correct": (ctx) => createMealsCorrectHandler(storeFrom(ctx))(ctx),
  "meals.delete": (ctx) => createMealsDeleteHandler(storeFrom(ctx))(ctx)
};
