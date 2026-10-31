// external-modules/meals/src/lists/deps.ts
//
// What the shopping list tools need from the worker context, as narrow ports so the handler
// tests can run against in-memory stores.
import type { KitchenView } from "../contracts.js";
import type { ListStore } from "../store/list-port.js";
import type { PlanStore } from "../store/plan-port.js";

export interface ListDeps {
  readonly lists: ListStore;
  readonly plans: PlanStore;
  /** The kitchen, read without writing. Read tools may only run SELECT. */
  readonly kitchen: () => Promise<KitchenView>;
  /** The kitchen, with its row stored. Write tools call it. */
  readonly ensureKitchen: () => Promise<KitchenView>;
  readonly newId: () => string;
  readonly now: () => Date;
}
