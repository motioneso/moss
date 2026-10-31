// external-modules/meals/src/worker/registry.ts
//
// The one handler-key to handler map for tools and queues. Keys match the manifest's
// assistantTools[].handler. The store is built per call from ctx.db, which exists only inside a
// call's context.
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import { sqlStore } from "../store/sql.js";
import {
  createHouseholdRemoveHandler,
  createHouseholdSaveHandler,
  createKitchenGetHandler,
  createKitchenSaveHandler
} from "../tools/household.js";

export type Handler = (ctx: ModuleWorkerContext) => Promise<unknown>;

const storeFrom = (ctx: ModuleWorkerContext) => sqlStore(ctx.db);

export const HANDLERS: Readonly<Record<string, Handler>> = {
  "kitchen.get": (ctx) => createKitchenGetHandler(storeFrom(ctx))(ctx),
  "kitchen.save": (ctx) => createKitchenSaveHandler(storeFrom(ctx))(ctx),
  "household.save": (ctx) => createHouseholdSaveHandler(storeFrom(ctx))(ctx),
  "household.remove": (ctx) => createHouseholdRemoveHandler(storeFrom(ctx))(ctx)
};
