// external-modules/meals/src/worker/registry.ts
//
// The one handler-key to handler map for tools and queues. Keys match the manifest's
// assistantTools[].handler and worker.queues[].handler. The store is built per call from
// ctx.db, which exists only inside a call's context.
import { randomUUID } from "node:crypto";

import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import type { ListDeps } from "../lists/deps.js";
import {
  listBought,
  listBuild,
  listClear,
  listEdit,
  listGet,
  listOnPantryChange,
  listOnPlanChange,
  undo
} from "../lists/tools.js";
import type { LogDeps, LogJobDeps } from "../log/deps.js";
import { runLogEstimate } from "../log/job.js";
import {
  logAdd,
  logCorrect,
  logDelete,
  logList,
  logReestimate,
  logSummarize
} from "../log/tools.js";
import {
  favouritesEdit,
  mealCooked,
  mealRate,
  mealServings,
  type CookingDeps
} from "../cooking/tools.js";
import { pantryEdit, pantryGet } from "../pantry/tools.js";
import type { PantryDeps } from "../pantry/tools.js";
import { runPlanDay } from "../plans/day-job.js";
import type { PlanDeps } from "../plans/deps.js";
import { runMealJob } from "../plans/meal-job.js";
import { mealEdit, mealSwap } from "../plans/meal-tools.js";
import {
  mealGet,
  planControl,
  planCreate,
  planCurrent,
  planDelete,
  planGet
} from "../plans/tools.js";
import { sqlCookingStore } from "../store/cooking.js";
import { sqlLogStore } from "../store/log.js";
import { sqlListStore } from "../store/list.js";
import { sqlPantryStore } from "../store/pantry.js";
import { sqlPlanStore } from "../store/plans.js";
import { sqlStore } from "../store/sql.js";
import { stripEnvelope } from "../tools/validate.js";
import {
  createHouseholdRemoveHandler,
  createHouseholdSaveHandler,
  createKitchenGetHandler,
  createKitchenSaveHandler
} from "../tools/household.js";

export type Handler = (ctx: ModuleWorkerContext) => Promise<unknown>;

const storeFrom = (ctx: ModuleWorkerContext) => sqlStore(ctx.db);

function listDeps(ctx: ModuleWorkerContext): ListDeps {
  const kitchens = storeFrom(ctx);
  return {
    lists: sqlListStore(ctx.db),
    plans: sqlPlanStore(ctx.db),
    pantry: sqlPantryStore(ctx.db),
    cooking: sqlCookingStore(ctx.db),
    kitchen: () => kitchens.readKitchen(),
    ensureKitchen: () => kitchens.getOrCreateKitchen(),
    newId: randomUUID,
    now: () => new Date()
  };
}

const list =
  (run: (deps: ListDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(listDeps(ctx), stripEnvelope(ctx.input));

function planDeps(ctx: ModuleWorkerContext): PlanDeps {
  const kitchens = storeFrom(ctx);
  return {
    onPlanChange: (planId, change) => listOnPlanChange(listDeps(ctx), planId, change),
    store: sqlPlanStore(ctx.db),
    pantry: sqlPantryStore(ctx.db),
    marks: () => sqlCookingStore(ctx.db).readMarks(),
    vetoes: (memberIds) => sqlCookingStore(ctx.db).vetoes(memberIds),
    kitchen: () => kitchens.readKitchen(),
    ensureKitchen: () => kitchens.getOrCreateKitchen(),
    ai: ctx.ai,
    jobs: ctx.jobs,
    newId: randomUUID,
    now: () => new Date(),
    localTimezone: ctx.localTimezone ?? undefined
  };
}

function cookingDeps(ctx: ModuleWorkerContext): CookingDeps {
  return {
    ...planDeps(ctx),
    pantry: sqlPantryStore(ctx.db),
    cooking: sqlCookingStore(ctx.db),
    now: () => new Date(),
    onPantryChange: () => listOnPantryChange(listDeps(ctx))
  };
}

const cooking =
  (run: (deps: CookingDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(cookingDeps(ctx), stripEnvelope(ctx.input));

function pantryDeps(ctx: ModuleWorkerContext): PantryDeps {
  const kitchens = storeFrom(ctx);
  return {
    pantry: sqlPantryStore(ctx.db),
    kitchen: () => kitchens.readKitchen(),
    ensureKitchen: () => kitchens.getOrCreateKitchen(),
    newId: randomUUID,
    onPantryChange: () => listOnPantryChange(listDeps(ctx))
  };
}

const pantryTool =
  (run: (deps: PantryDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(pantryDeps(ctx), stripEnvelope(ctx.input));

function logDeps(ctx: ModuleWorkerContext): LogDeps {
  const kitchens = storeFrom(ctx);
  return {
    store: sqlLogStore(ctx.db),
    kitchen: () => kitchens.readKitchen(),
    jobs: ctx.jobs,
    newId: randomUUID,
    now: () => new Date(),
    localTimezone: ctx.localTimezone ?? undefined
  };
}

const logTool =
  (run: (deps: LogDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(logDeps(ctx), stripEnvelope(ctx.input));

function logJobDeps(ctx: ModuleWorkerContext): LogJobDeps {
  return { store: sqlLogStore(ctx.db), ai: ctx.ai };
}

const plan =
  (run: (deps: PlanDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(planDeps(ctx), stripEnvelope(ctx.input));

/** A queue job arrives as { actorUserId, jobKind, idempotencyKey, params }. */
function jobParams(input: unknown): Record<string, unknown> {
  const params = (input as { readonly params?: unknown } | null)?.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("job params must be an object");
  }
  return params as Record<string, unknown>;
}

export const HANDLERS: Readonly<Record<string, Handler>> = {
  "kitchen.get": (ctx) => createKitchenGetHandler(storeFrom(ctx))(ctx),
  "kitchen.save": (ctx) => createKitchenSaveHandler(storeFrom(ctx))(ctx),
  "household.save": (ctx) => createHouseholdSaveHandler(storeFrom(ctx))(ctx),
  "household.remove": (ctx) => createHouseholdRemoveHandler(storeFrom(ctx))(ctx),
  "plan.create": plan(planCreate),
  "plan.get": plan(planGet),
  "plan.current": plan(planCurrent),
  "plan.control": plan(planControl),
  "plan.delete": plan(planDelete),
  "meal.get": plan(mealGet),
  "meal.cooked": cooking(mealCooked),
  "meal.servings": cooking(mealServings),
  "meal.rate": cooking(mealRate),
  "favourites.edit": cooking(favouritesEdit),
  "meal.edit": plan(mealEdit),
  "meal.swap": plan(mealSwap),
  "list.get": list(listGet),
  "list.build": list(listBuild),
  "list.edit": list(listEdit),
  "list.bought": list(listBought),
  "list.clear": list(listClear),
  "pantry.get": pantryTool(pantryGet),
  "pantry.edit": pantryTool(pantryEdit),
  undo: list(undo),
  "log.list": logTool(logList),
  "log.summarize": logTool(logSummarize),
  "log.add": logTool(logAdd),
  "log.correct": logTool(logCorrect),
  "log.reestimate": logTool(logReestimate),
  "log.delete": logTool(logDelete),
  "log.estimate": (ctx) => runLogEstimate(logJobDeps(ctx), jobParams(ctx.input)),
  "plan.day": (ctx) => runPlanDay(planDeps(ctx), jobParams(ctx.input)),
  "meal.job": (ctx) => runMealJob(planDeps(ctx), jobParams(ctx.input))
};
