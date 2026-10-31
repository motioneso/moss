// external-modules/meals/src/worker/registry.ts
//
// The one handler-key to handler map for tools and queues. Keys match the manifest's
// assistantTools[].handler and worker.queues[].handler. The store is built per call from
// ctx.db, which exists only inside a call's context.
import { randomUUID } from "node:crypto";

import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { runPlanDay } from "../plans/day-job.js";
import type { PlanDeps } from "../plans/deps.js";
import { mealGet, planControl, planCreate, planDelete, planGet } from "../plans/tools.js";
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

function planDeps(ctx: ModuleWorkerContext): PlanDeps {
  const kitchens = storeFrom(ctx);
  return {
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

export const HANDLERS: Readonly<Record<string, Handler>> = {
  "kitchen.get": (ctx) => createKitchenGetHandler(storeFrom(ctx))(ctx),
  "kitchen.save": (ctx) => createKitchenSaveHandler(storeFrom(ctx))(ctx),
  "household.save": (ctx) => createHouseholdSaveHandler(storeFrom(ctx))(ctx),
  "household.remove": (ctx) => createHouseholdRemoveHandler(storeFrom(ctx))(ctx),
  "plan.create": plan(planCreate),
  "plan.get": plan(planGet),
  "plan.control": plan(planControl),
  "plan.delete": plan(planDelete),
  "meal.get": plan(mealGet),
  "plan.day": plan(runPlanDay)
};
