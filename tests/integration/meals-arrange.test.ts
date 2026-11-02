// tests/integration/meals-arrange.test.ts
//
// Meals S8 (#3892): the SQL plan store moves a meal, replaces its eaters, turns it into text,
// adds a One-off meal, sets a cook-time limit, and splits and joins the meals of one slot for
// a Shared or Solo override. The store runs as the module runtime role with the actor set.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
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
  "app.meals_favourites",
  "app.meals_swap_choices"
];

async function asActor<T>(
  actorUserId: string,
  fn: (stores: { kitchens: MealsStore; plans: PlanStore }) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: connectionStrings.app });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL ROLE ${runtimeRole}`);
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorUserId]);
    const result = await fn({ kitchens: sqlStore(client), plans: sqlPlanStore(client) });
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

/** A two-day plan, one shared ready dinner per day eaten by the owner and Sam. */
async function seed(actorUserId: string, base: number) {
  return asActor(actorUserId, async ({ kitchens, plans }) => {
    const kitchen = await kitchens.getOrCreateKitchen();
    const self = kitchen.members.find((member) => member.isSelf)!;
    const sam = await kitchens.addMember(kitchen.kitchenId, {
      name: "Sam",
      mealPattern: ["dinner"]
    });
    const dayIds = [uuid(base + 1), uuid(base + 2)];
    const mealIds = [uuid(base + 10), uuid(base + 11)];
    await plans.createPlan({
      planId: uuid(base),
      kitchenId: kitchen.kitchenId,
      startDate: "2026-11-02",
      dayCount: 2,
      pantryMode: "prefer",
      requestText: "",
      allowRepeats: false,
      idempotencyKey: `arrange-${base}`,
      days: [
        { dayId: dayIds[0]!, date: "2026-11-02" },
        { dayId: dayIds[1]!, date: "2026-11-03" }
      ],
      meals: mealIds.map((mealId, index) => ({
        mealId,
        dayId: dayIds[index]!,
        slotName: "dinner",
        slotPosition: 0,
        sharing: "shared" as const,
        eaterIds: [self.memberId, sam.memberId]
      }))
    });
    for (const [index, mealId] of mealIds.entries()) {
      const dayId = dayIds[index]!;
      const generation = (await plans.bumpDay(dayId))!;
      await plans.claimDay(dayId, generation);
      await plans.claimMeal(mealId, dayId, generation);
      await plans.saveMealReady({
        mealId,
        generation,
        attempts: 1,
        kitchenId: kitchen.kitchenId,
        recipe: {
          recipeId: uuid(base + 20 + index),
          title: `Dish ${index}`,
          titleKey: `dish ${index}`,
          steps: ["Cook it."],
          cookMinutes: 30,
          baseServings: 2,
          kcalPerServing: 400,
          ingredients: [
            {
              originalText: "200 g rice",
              name: "Rice",
              quantity: 200,
              unit: "g",
              section: "pantry" as const,
              checkLabel: false
            }
          ]
        },
        eaters: [self.memberId, sam.memberId].map((memberId) => ({
          memberId,
          portion: 1,
          estimatedKcal: 400,
          safety: "pass" as const,
          safetyReason: null
        }))
      });
    }
    return {
      kitchenId: kitchen.kitchenId,
      self: self.memberId,
      sam: sam.memberId,
      dayIds,
      mealIds
    };
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

describe("meals arrange store (S8 #3892)", () => {
  it("moves a meal, replaces its eaters and turns it into text and back", async () => {
    const seeded = await seed(ids.userA, 1000);
    const [first, second] = seeded.mealIds;

    await asActor(ids.userA, async ({ plans }) => {
      expect(
        await plans.moveMeal({
          mealId: first!,
          dayId: seeded.dayIds[1]!,
          slotName: "dinner",
          slotPosition: 0
        })
      ).toBe(true);
      const moved = await plans.getMeal(first!);
      expect(moved?.dayId).toBe(seeded.dayIds[1]);

      expect(
        await plans.setMealEaters({
          mealId: second!,
          eaters: [
            {
              memberId: seeded.sam,
              portion: 1.5,
              estimatedKcal: 600,
              safety: "pending",
              safetyReason: null
            }
          ]
        })
      ).toBe(true);
      const changed = await plans.getMeal(second!);
      expect(changed?.eaters.map((eater) => eater.memberId)).toEqual([seeded.sam]);
      expect(changed?.servingsOverride).toBeNull();

      expect(await plans.setMealText(second!, "eating out")).toBe(true);
      const text = await plans.getMeal(second!);
      expect(text?.kind).toBe("text");
      expect(text?.recipeId).toBeNull();
      expect(await plans.clearMealText(second!)).toBe(true);
      expect((await plans.getMeal(second!))?.status).toBe("pending");

      expect(await plans.setDayCookLimit(seeded.dayIds[0]!, 20)).toBe(true);
      expect((await plans.getDay(seeded.dayIds[0]!))?.cookTimeLimitMinutes).toBe(20);
    });
  });

  it("adds a One-off meal and splits then joins one slot for one day only", async () => {
    const seeded = await seed(ids.userA, 2000);
    const oneOffId = uuid(2900);
    await asActor(ids.userA, async ({ plans }) => {
      expect(
        await plans.addOneOffMeal({
          mealId: oneOffId,
          kitchenId: seeded.kitchenId,
          dayId: seeded.dayIds[0]!,
          slotName: "dinner",
          slotPosition: 0,
          memberId: seeded.sam
        })
      ).toBe(true);
      const oneOff = await plans.getMeal(oneOffId);
      expect(oneOff?.oneOffFor).toBe(seeded.sam);
      expect(oneOff?.eaters.map((eater) => eater.memberId)).toEqual([seeded.sam]);

      expect(await plans.setDaySharing(seeded.dayIds[0]!, "dinner", "solo")).toBe(true);
      const shared = (await plans.listDayMeals(seeded.dayIds[0]!)).find(
        (meal) => meal.mealId === seeded.mealIds[0]
      )!;
      expect(
        await plans.splitMeal({
          mealId: shared.mealId,
          copies: [{ mealId: uuid(2901), memberId: seeded.sam }]
        })
      ).toBe(true);
      const split = (await plans.listDayMeals(seeded.dayIds[0]!)).filter(
        (meal) => meal.slotName === "dinner" && meal.recipeId !== null
      );
      expect(split.length).toBeGreaterThanOrEqual(2);
      for (const meal of split) expect(meal.eaters).toHaveLength(1);

      const eaters = [seeded.self, seeded.sam].map((memberId) => ({
        memberId,
        portion: 1,
        estimatedKcal: 400,
        safety: "pass" as const,
        safetyReason: null
      }));
      expect(
        await plans.mergeSlotMeals({
          dayId: seeded.dayIds[0]!,
          slotName: "dinner",
          keepMealId: seeded.mealIds[0]!,
          eaters
        })
      ).toBe(true);
      const joined = (await plans.listDayMeals(seeded.dayIds[0]!)).filter(
        (meal) => meal.mealId === seeded.mealIds[0]
      );
      expect(joined[0]?.sharing).toBe("shared");
      expect(joined[0]?.eaters).toHaveLength(2);
    });
  });

  it("keeps another owner's meals out of reach", async () => {
    const seeded = await seed(ids.userA, 3000);
    await asActor(ids.userB, async ({ plans }) => {
      expect(await plans.getMeal(seeded.mealIds[0]!)).toBeNull();
      expect(
        await plans.moveMeal({
          mealId: seeded.mealIds[0]!,
          dayId: seeded.dayIds[1]!,
          slotName: "dinner",
          slotPosition: 0
        })
      ).toBe(false);
      expect(await plans.setMealText(seeded.mealIds[0]!, "eating out")).toBe(false);
    });
    const still = await asActor(ids.userA, ({ plans }) => plans.getMeal(seeded.mealIds[0]!));
    expect(still?.kind).toBe("recipe");
  });
});
