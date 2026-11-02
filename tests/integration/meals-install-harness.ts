// tests/integration/meals-install-harness.ts
//
// Shared setup for the Meals install suites: one real install of external-modules/meals/sql
// through the module pipeline with FORCE RLS, the module runtime role scoped to an actor the way
// the worker's ctx.db is, and the plan fixtures each slice builds on.
import pg from "pg";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { classifyModuleStatement } from "../../packages/db/src/module-statement-classify.js";
import type { PlanStore } from "../../external-modules/meals/src/store/plan-port.js";
import { sqlPlanStore } from "../../external-modules/meals/src/store/plans.js";
import { sqlStore, type MealsStore } from "../../external-modules/meals/src/store/sql.js";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  laneScopedModuleId,
  resetFoundationDatabase,
  revokeModuleMembershipAtTeardown
} from "./test-database.js";

const { Client } = pg;

export const moduleId = laneScopedModuleId("meals");
export const installRole = moduleInstallRoleName(moduleId);
export const runtimeRole = moduleRuntimeRoleName(moduleId);
export const ownedTables = [
  "app.meals_kitchens",
  "app.meals_household_members",
  "app.meals_meal_slot_rules",
  "app.meals_plans",
  "app.meals_plan_days",
  "app.meals_recipes",
  "app.meals_recipe_ingredients",
  "app.meals_planned_meals",
  "app.meals_planned_meal_eaters",
  "app.meals_shopping_lists",
  "app.meals_shopping_list_items",
  "app.meals_pantry_items",
  "app.meals_staples",
  "app.meals_undo_actions",
  "app.meals_log_entries",
  "app.meals_log_estimates",
  "app.meals_log_estimate_items",
  "app.meals_ratings",
  "app.meals_favourites",
  "app.meals_swap_choices"
];

/** Runs the module install once; the second run must be a no-op. */
export async function install() {
  return installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/meals/sql"
  });
}

/**
 * Installs Meals into the freshly reset foundation database and grants the runtime role. Returns
 * how many migrations the install applied, which the schema catalog test pins.
 */
export async function startMeals(): Promise<number> {
  // Seeds app.users for ids.userA and ids.userB, which the owner foreign keys need.
  await resetFoundationDatabase();
  const installed = (await install()).installed.length;
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
  return installed;
}

/** Drops every table, role and install record this suite created. */
export async function stopMeals(): Promise<void> {
  await revokeModuleMembershipAtTeardown([`REVOKE ${runtimeRole} FROM jarvis_app_runtime`]);
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    for (const table of [...ownedTables].reverse()) {
      await client.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${runtimeRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${runtimeRole}`
    );
    await client.query(`REVOKE ALL PRIVILEGES ON SCHEMA app FROM ${installRole} CASCADE`);
    await client.query(`REVOKE ALL PRIVILEGES ON app.users FROM ${installRole}`);
    await client.query(
      `REVOKE EXECUTE ON FUNCTION app.current_actor_user_id() FROM ${installRole} CASCADE`
    );
    await dropModuleRolesAtTeardown([installRole, runtimeRole]);
    await client.query("DELETE FROM app.module_installs WHERE module_id = $1", [moduleId]);
    await client.query("DELETE FROM app.module_schema_migrations WHERE module_id = $1", [moduleId]);
  } finally {
    await client.end();
  }
}

/**
 * Runs `fn` in one transaction as the module runtime role, acting for `actorUserId`.
 * `readOnly` applies the host's read-tool rule (SELECT only) inside a READ ONLY transaction.
 */
export async function asActor<T>(
  actorUserId: string,
  fn: (store: MealsStore, client: pg.Client) => Promise<T>,
  options: { readOnly?: boolean } = {}
): Promise<T> {
  const client = new Client({ connectionString: connectionStrings.app });
  await client.connect();
  try {
    await client.query(options.readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await client.query(`SET LOCAL ROLE ${runtimeRole}`);
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    const db = options.readOnly
      ? {
          query: <R>(text: string, params?: readonly unknown[]) => {
            const kind = classifyModuleStatement(text);
            if (kind !== "select") throw new Error(`read tool ran ${kind}`);
            return client.query(text, params as unknown[]) as unknown as Promise<{ rows: R[] }>;
          }
        }
      : client;
    const result = await fn(sqlStore(db), client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/** Runs `fn` as `asActor` does, with the plan store. */
export function asPlanActor<T>(
  actorUserId: string,
  fn: (plans: PlanStore, kitchens: MealsStore) => Promise<T>
) {
  return asActor(actorUserId, (kitchens, client) => fn(sqlPlanStore(client), kitchens));
}

export const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export async function seedPlan(actorUserId: string, base: number, key: string) {
  return asPlanActor(actorUserId, async (plans, kitchens) => {
    const kitchen = await kitchens.getOrCreateKitchen();
    const self = kitchen.members.find((member) => member.isSelf)!.memberId;
    const days = [
      { dayId: uuid(base + 1), date: "2026-11-02" },
      { dayId: uuid(base + 2), date: "2026-11-03" }
    ];
    const created = await plans.createPlan({
      planId: uuid(base),
      kitchenId: kitchen.kitchenId,
      startDate: "2026-11-02",
      dayCount: 2,
      pantryMode: "prefer",
      requestText: "quick dinners",
      allowRepeats: false,
      idempotencyKey: key,
      days,
      meals: days.map((day, index) => ({
        mealId: uuid(base + 10 + index),
        dayId: day.dayId,
        slotName: "dinner",
        slotPosition: 0,
        sharing: "shared" as const,
        eaterIds: [self]
      }))
    });
    return { ...created, kitchenId: kitchen.kitchenId, self, days };
  });
}
