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
  listOnPlanChange,
  undo
} from "../lists/tools.js";
import { runPlanDay } from "../plans/day-job.js";
import type { PlanDeps } from "../plans/deps.js";
import {
  mealGet,
  planControl,
  planCreate,
  planCurrent,
  planDelete,
  planGet
} from "../plans/tools.js";
import { sqlListStore } from "../store/list.js";
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
    kitchen: () => kitchens.readKitchen(),
    ensureKitchen: () => kitchens.getOrCreateKitchen(),
    ai: ctx.ai,
    jobs: ctx.jobs,
    newId: randomUUID
  };
}

const plan =
  (run: (deps: PlanDeps, input: Record<string, unknown>) => Promise<unknown>): Handler =>
  (ctx) =>
    run(planDeps(ctx), stripEnvelope(ctx.input));

/** A queue job arrives as { actorUserId, jobKind, idempotencyKey, params }. */
function jobParams(input: unknown): Record<string, unknown> {
  const params = (input as { readonly params?: unknown } | null)?.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("plan-day: job params must be an object");
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
  "list.get": list(listGet),
  "list.build": list(listBuild),
  "list.edit": list(listEdit),
  "list.bought": list(listBought),
  "list.clear": list(listClear),
  undo: list(undo),
  "plan.day": (ctx) => runPlanDay(planDeps(ctx), jobParams(ctx.input))
};
