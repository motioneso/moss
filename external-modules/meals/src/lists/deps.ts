// external-modules/meals/src/lists/deps.ts
//
// What the shopping list tools need from the worker context, as narrow ports so the handler
// tests can run against in-memory stores.
import type { KitchenView } from "../contracts.js";
import type { CookingStore } from "../store/cooking-port.js";
import type { ListStore } from "../store/list-port.js";
import type { PantryStore } from "../store/pantry-port.js";
import type { PlanStore } from "../store/plan-port.js";

export interface ListDeps {
  readonly lists: ListStore;
  readonly plans: PlanStore;
  /** The Pantry and Staples. Absent in tests that build lists without a Pantry. */
  readonly pantry?: PantryStore;
  /** Mark cooked and its Undo. Absent in tests that never cook. */
  readonly cooking?: CookingStore;
  /** The kitchen, read without writing. Read tools may only run SELECT. */
  readonly kitchen: () => Promise<KitchenView>;
  /** The kitchen, with its row stored. Write tools call it. */
  readonly ensureKitchen: () => Promise<KitchenView>;
  readonly newId: () => string;
  readonly now: () => Date;
}
