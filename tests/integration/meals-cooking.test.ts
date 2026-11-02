// tests/integration/meals-cooking.test.ts
//
// Meals S10 (#3894): the ratings and favourites tables keep two owners apart, and the SQL cooking
// store marks a meal cooked, restores the Pantry on Undo, skips a row edited since, and reports
// one-star ratings as vetoes. The store runs as the module runtime role with the actor set.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { sqlCookingStore } from "../../external-modules/meals/src/store/cooking.js";
import type { CookingStore } from "../../external-modules/meals/src/store/cooking-port.js";
import { markKey } from "../../external-modules/meals/src/store/cooking-port.js";
import { sqlPantryStore } from "../../external-modules/meals/src/store/pantry.js";
import type { PantryStore } from "../../external-modules/meals/src/store/pantry-port.js";
import { sqlPlanStore } from "../../external-modules/meals/src/store/plans.js";
import type { PlanStore } from "../../external-modules/meals/src/store/plan-port.js";
import { sqlStore, type MealsStore } from "../../external-modules/meals/src/store/sql.js";
import {
  connectionStrings,
  dropModuleRolesAtTeardown,
  grantModuleMembershipAtSetup,
  ids,
  laneScopedModuleId,
  resetFoundationDatabase,
  revokeModuleMembershipAtTeardown
} from "./test-database.js";

const { Client } = pg;
const moduleId = laneScopedModuleId("meals");
const installRole = moduleInstallRoleName(moduleId);
const runtimeRole = moduleRuntimeRoleName(moduleId);
const ownedTables = [
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
  "app.meals_favourites"
];
const bare = (table: string) => table.replace(/^app\./, "");

async function asActor<T>(
  actorUserId: string,
  fn: (stores: {
    kitchens: MealsStore;
    plans: PlanStore;
    pantry: PantryStore;
    cooking: CookingStore;
    client: pg.Client;
  }) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: connectionStrings.app });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${runtimeRole}`);
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    const result = await fn({
      kitchens: sqlStore(client),
      plans: sqlPlanStore(client),
      pantry: sqlPantryStore(client),
      cooking: sqlCookingStore(client),
      client
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A one-day plan with one ready meal for the actor's own member. */
async function seedReadyMeal(actorUserId: string, base: number, title: string) {
  return asActor(actorUserId, async ({ kitchens, plans }) => {
    const kitchen = await kitchens.getOrCreateKitchen();
    const self = kitchen.members.find((member) => member.isSelf)!.memberId;
    const dayId = uuid(base + 1);
    const mealId = uuid(base + 10);
    const recipeId = uuid(base + 20);
    await plans.createPlan({
      planId: uuid(base),
      kitchenId: kitchen.kitchenId,
      startDate: "2026-11-02",
      dayCount: 1,
      pantryMode: "prefer",
      requestText: "",
      allowRepeats: false,
      idempotencyKey: `cook-${base}`,
      days: [{ dayId, date: "2026-11-02" }],
      meals: [
        {
          mealId,
          dayId,
          slotName: "dinner",
          slotPosition: 0,
          sharing: "shared" as const,
          eaterIds: [self]
        }
      ]
    });
    const generation = (await plans.bumpDay(dayId))!;
    await plans.claimDay(dayId, generation);
    await plans.claimMeal(mealId, dayId, generation);
    await plans.saveMealReady({
      mealId,
      generation,
      attempts: 1,
      kitchenId: kitchen.kitchenId,
      recipe: {
        recipeId,
        title,
        titleKey: title.toLowerCase(),
        steps: ["Cook it."],
        cookMinutes: 20,
        baseServings: 2,
        kcalPerServing: 400,
        ingredients: [
          {
            originalText: "200 g rice",
            name: "Rice",
            quantity: 200,
            unit: "g",
            section: "pantry" as const,
            checkLabel: true
          }
        ]
      },
      eaters: [
        { memberId: self, portion: 1, estimatedKcal: 400, safety: "pass", safetyReason: null }
      ]
    });
    return { kitchenId: kitchen.kitchenId, self, mealId, recipeId };
  });
}

beforeAll(async () => {
  await resetFoundationDatabase();
  await installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/meals/sql"
  });
  await grantModuleMembershipAtSetup([
    `GRANT ${runtimeRole} TO jarvis_app_runtime WITH INHERIT FALSE`
  ]);
});

afterAll(async () => {
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
});

describe("meals ratings and favourites tables (S10 #3894)", () => {
  it("forces row level security on both tables", async () => {
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const forced = await client.query<{ relname: string }>(
        "SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relforcerowsecurity",
        [["meals_ratings", "meals_favourites"].map((name) => name)]
      );
      expect(forced.rows.map((row) => row.relname).sort()).toEqual(
        ["meals_favourites", "meals_ratings"].sort()
      );
      expect(bare("app.meals_ratings")).toBe("meals_ratings");
    } finally {
      await client.end();
    }
  });

  it("keeps ratings and favourites private to their owner, and a one-star rating is a veto", async () => {
    const a = await seedReadyMeal(ids.userA, 7000, "Burnt Toast");
    const b = await seedReadyMeal(ids.userB, 8000, "Burnt Toast");

    await asActor(ids.userA, async ({ cooking }) => {
      await cooking.setRating(a.kitchenId, a.self, a.recipeId, 1);
      await cooking.setFavourite(a.kitchenId, a.self, a.recipeId, true);
    });

    const seenByA = await asActor(ids.userA, ({ cooking }) => cooking.readMarks());
    expect(seenByA.ratings.get(markKey(a.self, a.recipeId))).toBe(1);
    expect(seenByA.favourites.has(markKey(a.self, a.recipeId))).toBe(true);

    const seenByB = await asActor(ids.userB, ({ cooking }) => cooking.readMarks());
    expect(seenByB.ratings.size).toBe(0);
    expect(seenByB.favourites.size).toBe(0);

    // B cannot rate A's recipe: the owner check rejects the insert.
    await expect(
      asActor(ids.userB, ({ cooking }) => cooking.setRating(b.kitchenId, a.self, a.recipeId, 5))
    ).rejects.toThrow();

    expect(await asActor(ids.userA, ({ cooking }) => cooking.vetoes([a.self]))).toEqual([
      { memberId: a.self, title: "Burnt Toast", titleKey: "burnt toast" }
    ]);
    expect(await asActor(ids.userB, ({ cooking }) => cooking.vetoes([a.self]))).toEqual([]);

    await asActor(ids.userA, ({ cooking }) =>
      cooking.setRating(a.kitchenId, a.self, a.recipeId, 4)
    );
    expect(await asActor(ids.userA, ({ cooking }) => cooking.vetoes([a.self]))).toEqual([]);
    await asActor(ids.userA, async ({ cooking }) => {
      await cooking.setRating(a.kitchenId, a.self, a.recipeId, null);
      await cooking.setFavourite(a.kitchenId, a.self, a.recipeId, false);
    });
    const cleared = await asActor(ids.userA, ({ cooking }) => cooking.readMarks());
    expect(cleared.ratings.size).toBe(0);
    expect(cleared.favourites.size).toBe(0);
  });

  it("marks a meal cooked once, restores the Pantry on Undo, and skips a row edited since", async () => {
    const seeded = await seedReadyMeal(ids.userA, 9000, "Rice Bowl");
    const itemId = uuid(9100);
    const otherId = uuid(9101);
    await asActor(ids.userA, async ({ pantry }) => {
      for (const [id, name] of [
        [itemId, "Rice"],
        [otherId, "Beans"]
      ] as const) {
        await pantry.addItem(seeded.kitchenId, {
          itemId: id,
          name,
          nameKey: name.toLowerCase(),
          quantity: 500,
          unit: "g"
        });
      }
    });

    const at = "2026-11-02T18:00:00.000Z";
    const state = {
      mealId: seeded.mealId,
      at,
      changes: [
        { itemId, name: "Rice", unit: "g", before: 500, after: 300 },
        { itemId: otherId, name: "Beans", unit: "g", before: 500, after: 400 }
      ]
    };
    const actionId = uuid(9200);
    expect(
      await asActor(ids.userA, ({ cooking }) =>
        cooking.markCooked({ actionId, kitchenId: seeded.kitchenId, state })
      )
    ).toBe(true);
    expect(
      await asActor(ids.userA, ({ cooking }) =>
        cooking.markCooked({ actionId: uuid(9201), kitchenId: seeded.kitchenId, state })
      )
    ).toBe(false);

    const afterCook = await asActor(ids.userA, async ({ pantry, plans }) => ({
      stock: new Map((await pantry.readItems()).map((item) => [item.itemId, item.quantity])),
      meal: await plans.getMeal(seeded.mealId)
    }));
    expect(afterCook.stock.get(itemId)).toBe(300);
    expect(afterCook.stock.get(otherId)).toBe(400);
    expect(afterCook.meal?.cookedAt).not.toBeNull();

    // The Beans row is edited after cooking, so Undo leaves it alone.
    await asActor(ids.userA, ({ pantry }) => pantry.updateItem(otherId, { quantity: 50 }));

    const restored = await asActor(ids.userA, ({ cooking }) => cooking.undoCooked(actionId, state));
    expect(restored).toBe(1);
    const afterUndo = await asActor(ids.userA, async ({ pantry, plans }) => ({
      stock: new Map((await pantry.readItems()).map((item) => [item.itemId, item.quantity])),
      meal: await plans.getMeal(seeded.mealId)
    }));
    expect(afterUndo.stock.get(itemId)).toBe(500);
    expect(afterUndo.stock.get(otherId)).toBe(50);
    expect(afterUndo.meal?.cookedAt).toBeNull();

    expect(await asActor(ids.userA, ({ cooking }) => cooking.undoCooked(actionId, state))).toBe(0);
  });

  it("places a favourite into an unlocked meal and refuses a locked one", async () => {
    const seeded = await seedReadyMeal(ids.userA, 9500, "Veggie Chilli");
    const placed = await asActor(ids.userA, ({ cooking }) =>
      cooking.placeRecipe({
        mealId: seeded.mealId,
        recipeId: seeded.recipeId,
        favouriteOf: seeded.self,
        eaters: [{ memberId: seeded.self, safety: "pass", safetyReason: null, estimatedKcal: 410 }]
      })
    );
    expect(placed).toBe(true);
    const meal = await asActor(ids.userA, ({ plans }) => plans.getMeal(seeded.mealId));
    expect(meal?.eaters[0]).toMatchObject({ safety: "pass", estimatedKcal: 410 });

    await asActor(ids.userA, ({ client }) =>
      client.query("UPDATE app.meals_planned_meals SET locked = true WHERE meal_id = $1", [
        seeded.mealId
      ])
    );
    expect(
      await asActor(ids.userA, ({ cooking }) =>
        cooking.placeRecipe({
          mealId: seeded.mealId,
          recipeId: seeded.recipeId,
          favouriteOf: seeded.self,
          eaters: []
        })
      )
    ).toBe(false);
  });
});
