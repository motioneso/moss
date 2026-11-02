// tests/integration/meals-tables-install.test.ts
//
// Meals S1 (#3885) and S2 (#3886): the real external-modules/meals/sql installs through the module pipeline
// with FORCE RLS, and the real SQL store keeps two owners apart. The store runs as the module's
// runtime role with the actor set, exactly as the worker's ctx.db does.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { installModule } from "../../scripts/module-install.js";
import {
  moduleInstallRoleName,
  moduleRuntimeRoleName
} from "../../packages/db/src/module-role-broker.js";
import { classifyModuleStatement } from "../../packages/db/src/module-statement-classify.js";
import type { PlanStore } from "../../external-modules/meals/src/store/plan-port.js";
import type { ListStore } from "../../external-modules/meals/src/store/list-port.js";
import type { LogStore } from "../../external-modules/meals/src/store/log-port.js";
import { sqlLogStore } from "../../external-modules/meals/src/store/log.js";
import { sqlListStore } from "../../external-modules/meals/src/store/list.js";
import { sqlPlanStore } from "../../external-modules/meals/src/store/plans.js";
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
const bare = (table: string) => table.replace(/^app\./, "");

async function install() {
  return installModule({
    moduleId,
    manifest: { database: { ownedTables } },
    bootstrapConnectionString: connectionStrings.bootstrap,
    migrationConnectionString: connectionStrings.migration,
    migrationsDirectory: "external-modules/meals/sql"
  });
}

/**
 * Runs `fn` in one transaction as the module runtime role, acting for `actorUserId`.
 * `readOnly` applies the host's read-tool rule (SELECT only) inside a READ ONLY transaction.
 */
async function asActor<T>(
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

let installedCount = 0;

beforeAll(async () => {
  // Seeds app.users for ids.userA and ids.userB, which the owner foreign keys need.
  await resetFoundationDatabase();
  installedCount = (await install()).installed.length;
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

describe("meals tables (S1 #3885)", () => {
  it("installs every migration with FORCE RLS on every table, and re-runs as a no-op", async () => {
    expect(installedCount).toBe(27);
    const client = new Client({ connectionString: connectionStrings.bootstrap });
    await client.connect();
    try {
      const forced = await client.query<{ relname: string }>(
        "SELECT relname FROM pg_class WHERE relname = ANY($1::text[]) AND relforcerowsecurity",
        [ownedTables.map(bare)]
      );
      expect(forced.rows.map((row) => row.relname).sort()).toEqual(ownedTables.map(bare).sort());
    } finally {
      await client.end();
    }
    expect((await install()).installed).toHaveLength(0);
  });

  it("reads a new owner's Kitchen without writing, with the ids the first write keeps", async () => {
    const read = await asActor(ids.userB, (store) => store.readKitchen(), { readOnly: true });
    expect(read.members).toHaveLength(1);
    expect(read.members[0]).toMatchObject({ name: "You", isSelf: true });
    expect(read).toMatchObject({ unitsSystem: "us", defaultPantryMode: "prefer", slotRules: [] });

    const saved = await asActor(ids.userB, (store) => store.getOrCreateKitchen());
    expect(saved.kitchenId).toBe(read.kitchenId);
    expect(saved.members[0]!.memberId).toBe(read.members[0]!.memberId);

    const reread = await asActor(ids.userB, (store) => store.readKitchen(), { readOnly: true });
    expect(reread).toEqual(saved);

    const other = await asActor(ids.userA, (store) => store.readKitchen(), { readOnly: true });
    expect(other.kitchenId).not.toBe(read.kitchenId);
    expect(other.members[0]!.memberId).not.toBe(read.members[0]!.memberId);
  });

  it("creates one Kitchen and one self member even when two first writes race", async () => {
    const [first, second] = await Promise.all([
      asActor(ids.userA, (store) => store.getOrCreateKitchen()),
      asActor(ids.userA, (store) => store.getOrCreateKitchen())
    ]);
    expect(second.kitchenId).toBe(first.kitchenId);
    const kitchen = await asActor(ids.userA, (store) => store.getOrCreateKitchen());
    expect(kitchen.members.filter((member) => member.isSelf)).toHaveLength(1);
    expect(kitchen.members[0]).toMatchObject({
      name: "You",
      mealPattern: ["breakfast", "lunch", "dinner"]
    });
  });

  it("stores a Monday to Friday solo lunch as one row per slot", async () => {
    const kitchen = await asActor(ids.userA, async (store) => {
      const { kitchenId } = await store.getOrCreateKitchen();
      await store.upsertSlotRules(kitchenId, [
        { slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: "12:30" }
      ]);
      await store.upsertSlotRules(kitchenId, [
        { slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: null }
      ]);
      return store.getOrCreateKitchen();
    });
    expect(kitchen.slotRules).toEqual([
      { slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: null }
    ]);
    const rows = await asActor(ids.userA, async (_store, client) =>
      client.query("SELECT slot_name FROM app.meals_meal_slot_rules")
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("keeps the self row when asked to remove it", async () => {
    const removed = await asActor(ids.userA, async (store) => {
      const kitchen = await store.getOrCreateKitchen();
      return store.removeMember(kitchen.members.find((member) => member.isSelf)!.memberId);
    });
    expect(removed).toBe(false);
    const kitchen = await asActor(ids.userA, (store) => store.getOrCreateKitchen());
    expect(kitchen.members.some((member) => member.isSelf)).toBe(true);
  });

  it("never lets a second owner read, change or delete the first owner's rows", async () => {
    const sam = await asActor(ids.userA, async (store) => {
      const { kitchenId } = await store.getOrCreateKitchen();
      return store.addMember(kitchenId, { name: "Sam", restrictions: ["peanuts"] });
    });

    const seenByB = await asActor(ids.userB, (store) => store.getOrCreateKitchen());
    expect(seenByB.members.map((member) => member.name)).toEqual(["You"]);
    expect(seenByB.slotRules).toEqual([]);

    await asActor(ids.userB, async (store, client) => {
      expect(await store.updateMember(sam.memberId, { name: "Taken" })).toBeNull();
      expect(await store.removeMember(sam.memberId)).toBe(false);
      for (const table of ownedTables) {
        const visible = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id = $1`,
          [ids.userA]
        );
        expect(visible.rows[0].n, table).toBe(0);
      }
      const deleted = await client.query(
        "DELETE FROM app.meals_household_members WHERE owner_user_id = $1",
        [ids.userA]
      );
      expect(deleted.rowCount).toBe(0);
    });

    await expect(
      asActor(ids.userB, (_store, client) =>
        client.query(
          "INSERT INTO app.meals_kitchens (owner_user_id, kitchen_id) VALUES ($1, gen_random_uuid())",
          [ids.userA]
        )
      )
    ).rejects.toThrow(/row-level security/);

    const stillA = await asActor(ids.userA, (store) => store.getOrCreateKitchen());
    expect(stillA.members.find((member) => member.memberId === sam.memberId)).toMatchObject({
      name: "Sam",
      restrictions: ["peanuts"]
    });
  });
});

/** Runs `fn` as `asActor` does, with the plan store. */
function asPlanActor<T>(
  actorUserId: string,
  fn: (plans: PlanStore, kitchens: MealsStore) => Promise<T>
) {
  return asActor(actorUserId, (kitchens, client) => fn(sqlPlanStore(client), kitchens));
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

async function seedPlan(actorUserId: string, base: number, key: string) {
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

describe("meals plan tables (S2 #3886)", () => {
  it("creates a plan with its days, meals and eaters once per idempotency key", async () => {
    const first = await seedPlan(ids.userA, 1000, "plan-a");
    const again = await seedPlan(ids.userA, 2000, "plan-a");
    expect(first.created).toBe(true);
    expect(again).toMatchObject({ created: false, planId: first.planId });

    await asPlanActor(ids.userA, async (plans) => {
      expect(await plans.getPlan(first.planId)).toMatchObject({
        startDate: "2026-11-02",
        dayCount: 2,
        requestText: "quick dinners",
        state: "active",
        pausedReason: null
      });
      const days = await plans.listDays(first.planId);
      expect(days.map((day) => [day.date, day.status, day.generation])).toEqual([
        ["2026-11-02", "pending", 0],
        ["2026-11-03", "pending", 0]
      ]);
      const meals = await plans.listMeals(first.planId);
      expect(meals).toHaveLength(2);
      expect(meals[0]!.eaters).toEqual([
        {
          memberId: first.self,
          portion: 1,
          estimatedKcal: null,
          safety: "pending",
          safetyReason: null
        }
      ]);
      expect(await plans.findPlanByDate("2026-11-03")).toBe(first.planId);
      expect(await plans.findPlanByKey("plan-a")).toBe(first.planId);
    });
  });

  it("saves a meal only under the current generation and only while the plan is active", async () => {
    const seeded = await seedPlan(ids.userA, 3000, "plan-gen");
    const dayId = seeded.days[0]!.dayId;
    const mealId = uuid(3010);
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.bumpDay(dayId))!;
      expect(generation).toBe(1);
      expect(await plans.claimDay(dayId, generation + 1)).toBe(false);
      expect(await plans.claimDay(dayId, generation)).toBe(true);

      await plans.setPlanState(seeded.planId, "stopped", null);
      expect(await plans.claimMeal(mealId, dayId, generation)).toBe(false);
      await plans.setPlanState(seeded.planId, "active", null);
      expect(await plans.claimMeal(mealId, dayId, generation)).toBe(true);

      const ready = {
        mealId,
        attempts: 2,
        kitchenId: seeded.kitchenId,
        recipe: {
          recipeId: uuid(3100),
          title: "Rice Bowl",
          titleKey: "rice bowl",
          steps: ["Cook the rice."],
          cookMinutes: 25,
          baseServings: 2,
          kcalPerServing: 420,
          ingredients: [
            {
              originalText: "1.5 cups rice",
              name: "Rice",
              quantity: 1.5,
              unit: "cup",
              section: "pantry" as const,
              checkLabel: true
            }
          ]
        },
        eaters: [
          {
            memberId: seeded.self,
            portion: 1.5,
            estimatedKcal: 630,
            safety: "pass" as const,
            safetyReason: null
          }
        ]
      };
      expect(await plans.saveMealReady({ ...ready, generation: generation + 1 })).toBe(false);
      expect(await plans.saveMealReady({ ...ready, generation })).toBe(true);
      expect(await plans.saveMealReady({ ...ready, generation })).toBe(false);

      const meal = (await plans.getMeal(mealId))!;
      expect(meal).toMatchObject({
        status: "ready",
        attempts: 2,
        recipeId: uuid(3100),
        planId: seeded.planId,
        date: "2026-11-02"
      });
      expect(meal.eaters[0]).toMatchObject({ portion: 1.5, estimatedKcal: 630, safety: "pass" });
      const [recipe] = await plans.getRecipes([uuid(3100)]);
      expect(recipe).toMatchObject({
        baseServings: 2,
        kcalPerServing: 420,
        steps: ["Cook the rice."]
      });
      expect(recipe!.ingredients).toEqual([ready.recipe.ingredients[0]]);
      expect(await plans.recentTitles(seeded.kitchenId, "2026-10-26", "2026-11-02")).toContainEqual(
        { title: "Rice Bowl", titleKey: "rice bowl" }
      );

      expect(await plans.finishDay(dayId, generation, "ready", null)).toBe(true);
      expect(await plans.claimDay(dayId, (await plans.bumpDay(dayId))!)).toBe(true);
      expect((await plans.getMeal(mealId))!.status).toBe("ready");
    });
  });

  it("claims one day per plan at a time, unless the writing day outlived the job ceiling", async () => {
    const seeded = await seedPlan(ids.userA, 6000, "plan-one-at-a-time");
    const [first, second] = seeded.days.map((day) => day.dayId);
    await asActor(ids.userA, async (_kitchens, client) => {
      const plans = sqlPlanStore(client);
      const genFirst = (await plans.bumpDay(first!))!;
      const genSecond = (await plans.bumpDay(second!))!;
      expect(await plans.claimDay(first!, genFirst)).toBe(true);
      expect(await plans.claimDay(second!, genSecond)).toBe(false);
      expect(await plans.claimDay(first!, genFirst)).toBe(true);

      await client.query(
        "UPDATE app.meals_plan_days SET updated_at = now() - interval '12 minutes' WHERE day_id = $1",
        [first]
      );
      expect(await plans.claimDay(second!, genSecond)).toBe(true);
    });
  });

  it("marks a meal failed with its verdicts, and a bump sets it back to pending", async () => {
    const seeded = await seedPlan(ids.userA, 4000, "plan-fail");
    const dayId = seeded.days[1]!.dayId;
    const mealId = uuid(4011);
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.bumpDay(dayId))!;
      expect(await plans.claimMeal(mealId, dayId, generation)).toBe(true);
      const verdict = {
        memberId: seeded.self,
        portion: 1,
        estimatedKcal: null,
        safety: "fail" as const,
        safetyReason: "contains peanuts"
      };
      expect(await plans.failMeal(mealId, generation, "safety_cap", 3, [verdict])).toBe(true);
      expect(await plans.getMeal(mealId)).toMatchObject({
        status: "failed",
        failureReason: "safety_cap",
        attempts: 3,
        eaters: [verdict]
      });
      await plans.bumpDay(dayId);
      expect(await plans.getMeal(mealId)).toMatchObject({ status: "pending", failureReason: null });
    });
  });

  it("never lets a second owner read, change or delete the first owner's plan", async () => {
    const seeded = await seedPlan(ids.userA, 5000, "plan-private");
    await asPlanActor(ids.userB, async (plans) => {
      expect(await plans.getPlan(seeded.planId)).toBeNull();
      expect(await plans.findPlanByKey("plan-private")).toBeNull();
      expect(await plans.listMeals(seeded.planId)).toEqual([]);
      expect(await plans.bumpDay(seeded.days[0]!.dayId)).toBeNull();
      await plans.setPlanState(seeded.planId, "stopped", null);
      expect(await plans.deletePlan(seeded.planId)).toBe(false);
    });
    const countsForA = () =>
      asActor(ids.userA, async (_store, client) => {
        const counts: Record<string, number> = {};
        for (const table of ownedTables) {
          const { rows } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
          counts[table] = rows[0].n;
        }
        return counts;
      });
    const before = await countsForA();
    await asActor(ids.userB, async (_store, client) => {
      for (const table of ownedTables) {
        const visible = await client.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE owner_user_id = $1`,
          [ids.userA]
        );
        expect(visible.rows[0].n, table).toBe(0);
        const updated = await client.query(
          `UPDATE ${table} SET owner_user_id = owner_user_id WHERE owner_user_id = $1 RETURNING 1`,
          [ids.userA]
        );
        expect(updated.rows, table).toHaveLength(0);
        const deleted = await client.query(
          `DELETE FROM ${table} WHERE owner_user_id = $1 RETURNING 1`,
          [ids.userA]
        );
        expect(deleted.rows, table).toHaveLength(0);
      }
    });
    expect(await countsForA()).toEqual(before);
    await asPlanActor(ids.userA, async (plans) => {
      expect(await plans.getPlan(seeded.planId)).toMatchObject({ state: "active" });
      expect(await plans.deletePlan(seeded.planId)).toBe(true);
      expect(await plans.listDays(seeded.planId)).toEqual([]);
      expect(await plans.getMeal(uuid(5010))).toBeNull();
    });
  });
  it("picks the current plan by cover, then next to start, then newest, per owner", async () => {
    const owner = ids.userB;
    // Created in this order so that "newest" is the covering plan, not the last-starting one.
    const make = (base: number, startDate: string, dayCount: number, key: string) =>
      asPlanActor(owner, async (plans, kitchens) => {
        const kitchen = await kitchens.getOrCreateKitchen();
        const days = Array.from({ length: dayCount }, (_, index) => {
          const date = new Date(Date.parse(`${startDate}T00:00:00Z`) + index * 86_400_000);
          return { dayId: uuid(base + 1 + index), date: date.toISOString().slice(0, 10) };
        });
        const created = await plans.createPlan({
          planId: uuid(base),
          kitchenId: kitchen.kitchenId,
          startDate,
          dayCount,
          pantryMode: "prefer",
          requestText: null,
          allowRepeats: false,
          idempotencyKey: key,
          days,
          meals: []
        });
        return created.planId;
      });
    const past = await make(7000, "2026-10-01", 2, "cur-past");
    const future = await make(7100, "2026-11-20", 2, "cur-future");
    const covering = await make(7200, "2026-11-02", 3, "cur-covering");

    await asPlanActor(owner, async (plans) => {
      expect(await plans.findCurrentPlan("2026-11-03")).toBe(covering);
      expect(await plans.findCurrentPlan("2026-11-10")).toBe(future);
      expect(await plans.findCurrentPlan("2026-12-01")).toBe(covering);
      expect(await plans.findCurrentPlan("2026-10-01")).toBe(past);
    });
    await asPlanActor(ids.adminUser, async (plans) => {
      expect(await plans.findCurrentPlan("2026-11-03")).toBeNull();
    });
  });
});

/** Runs `fn` as `asActor` does, with the shopping list store. */
function asListActor<T>(
  actorUserId: string,
  fn: (lists: ListStore, kitchenId: string) => Promise<T>
) {
  return asActor(actorUserId, async (kitchens, client) => {
    const kitchen = await kitchens.getOrCreateKitchen();
    return fn(sqlListStore(client), kitchen.kitchenId);
  });
}

describe("shopping list (S4 #3888)", () => {
  const generated = (name: string) => ({
    lineKey: `${name}|`,
    nameKey: name,
    name,
    quantity: 2,
    unit: null,
    purchase: null,
    section: "produce" as const,
    coveredByPantry: false,
    convertedFrom: [],
    sourceMealIds: []
  });

  it("builds, ticks, buys and undoes for one owner, and keeps a second owner out", async () => {
    const at = "2026-11-02T10:00:00.000Z";
    const lineId = uuid(9001);
    const itemId = uuid(9002);
    const milkId = uuid(9003);
    await asListActor(ids.userA, async (lists, kitchenId) => {
      expect((await lists.readList()).exists).toBe(false);
      const listId = await lists.ensureList(kitchenId, null);
      await lists.applyDiff(
        listId,
        kitchenId,
        { insert: [generated("carrot")], update: [], remove: [] },
        [lineId]
      );
      await lists.addManual(listId, kitchenId, {
        lineId: milkId,
        name: "milk",
        quantity: 1,
        unit: "l",
        section: "dairy_eggs"
      });
      expect(await lists.setTicks([lineId], true)).toBe(1);
      const stored = await lists.readList();
      expect(stored.lines.map((line) => line.name).sort()).toEqual(["carrot", "milk"]);
      expect(stored.lines.find((line) => line.lineId === lineId)?.checkedAt).not.toBeNull();

      await lists.markBought({
        listId,
        kitchenId,
        at,
        actionId: uuid(9004),
        rows: [{ lineId, itemId, name: "carrot", nameKey: "carrot", quantity: 2, unit: null }]
      });
      const bought = await lists.readList();
      expect(bought.lines.find((line) => line.lineId === lineId)?.boughtAt).not.toBeNull();
      const undo = await lists.readUndo(uuid(9004));
      expect(undo?.kind).toBe("bought");
      expect(await lists.undoBought(uuid(9004), at, [lineId], [itemId])).toEqual({
        restored: 1,
        skipped: 0
      });
      const after = await lists.readList();
      expect(after.lines.find((line) => line.lineId === lineId)?.boughtAt).toBeNull();
    });

    await asListActor(ids.userB, async (lists) => {
      const theirs = await lists.readList();
      expect(theirs.exists).toBe(false);
      expect(theirs.lines).toEqual([]);
      expect(await lists.setTicks([milkId], true)).toBe(0);
      expect(await lists.updateLine(milkId, { name: "stolen" })).toBeNull();
      expect(await lists.readUndo(uuid(9004))).toBeNull();
    });
    await asActor(ids.userB, async (_store, client) => {
      for (const table of ownedTables.slice(-4)) {
        const deleted = await client.query(
          `DELETE FROM ${table} WHERE owner_user_id = $1 RETURNING 1`,
          [ids.userA]
        );
        expect(deleted.rows, table).toHaveLength(0);
      }
    });
    await asListActor(ids.userA, async (lists) => {
      const mine = await lists.readList();
      expect(mine.lines.find((line) => line.lineId === milkId)?.name).toBe("milk");
    });
  });
});

/** Runs `fn` as `asActor` does, with the food log store. */
function asLogActor<T>(actorUserId: string, fn: (log: LogStore, client: pg.Client) => Promise<T>) {
  return asActor(actorUserId, (_kitchens, client) => fn(sqlLogStore(client), client));
}

describe("meal log (S6 #3890)", () => {
  const nutrients = (caloriesKcal: number | null, proteinG: number | null) => ({
    caloriesKcal,
    proteinG,
    carbohydratesG: null,
    fatG: null,
    fiberG: null,
    sugarG: null,
    sodiumMg: null
  });

  it("keeps two owners apart through create, estimate, correct and delete", async () => {
    const entryId = uuid(9100);
    const created = await asLogActor(ids.userA, (log) =>
      log.createEntry({
        entryId,
        consumedAt: new Date("2026-10-30T12:30:00Z"),
        localDate: "2026-10-30",
        timezoneOffset: 0,
        description: "two eggs on toast",
        servingNote: null,
        captureKind: "text",
        idempotencyKey: "s6-key-1"
      })
    );
    expect(created).toMatchObject({ created: true });
    expect(created.entry).toMatchObject({ estimateState: "pending", estimateRevision: 1 });

    const again = await asLogActor(ids.userA, (log) =>
      log.createEntry({
        entryId: uuid(9101),
        consumedAt: new Date("2026-10-30T12:30:00Z"),
        localDate: "2026-10-30",
        timezoneOffset: 0,
        description: "two eggs on toast",
        servingNote: null,
        captureKind: "text",
        idempotencyKey: "s6-key-1"
      })
    );
    expect(again.created).toBe(false);
    expect(again.entry.entryId).toBe(entryId);

    const estimated = await asLogActor(ids.userA, (log) =>
      log.recordEstimate(entryId, 1, {
        state: "estimated",
        items: [{ label: "eggs", portionNote: "2", nutrients: nutrients(180, 12) }],
        nutrients: nutrients(180, 12),
        missingDetails: null,
        clarificationQuestion: null
      })
    );
    expect(estimated).toMatchObject({ estimateState: "estimated", estimateRevision: 2 });

    // A stale revision applies nothing.
    expect(
      await asLogActor(ids.userA, (log) => log.correctEntry(entryId, 1, { description: "stale" }))
    ).toBeNull();

    const corrected = await asLogActor(ids.userA, (log) =>
      log.correctEntry(entryId, 2, { items: [{ nutrients: { caloriesKcal: 200 } }] })
    );
    expect(corrected?.estimateRevision).toBe(3);
    expect(corrected?.items[0]?.nutrients).toMatchObject({ caloriesKcal: 200, proteinG: 12 });

    await asLogActor(ids.userB, async (log, client) => {
      expect(await log.getEntry(entryId)).toBeNull();
      expect(await log.listForLocalDate("2026-10-30")).toEqual([]);
      expect(
        await log.recordEstimate(entryId, 3, {
          state: "estimated",
          items: [],
          nutrients: null,
          missingDetails: null,
          clarificationQuestion: null
        })
      ).toBeNull();
      expect(await log.correctEntry(entryId, 3, { description: "mine now" })).toBeNull();
      expect(await log.deleteEntry(entryId)).toBe(false);
      for (const table of [
        "meals_log_entries",
        "meals_log_estimates",
        "meals_log_estimate_items"
      ]) {
        const gone = await client.query(`DELETE FROM app.${table} WHERE owner_user_id = $1`, [
          ids.userA
        ]);
        expect(gone.rowCount).toBe(0);
        const upd = await client.query(
          `UPDATE app.${table} SET owner_user_id = owner_user_id WHERE owner_user_id = $1`,
          [ids.userA]
        );
        expect(upd.rowCount).toBe(0);
      }
    });

    const mine = await asLogActor(ids.userA, (log) => log.getEntry(entryId));
    expect(mine).toMatchObject({ description: "two eggs on toast", estimateRevision: 3 });

    expect(await asLogActor(ids.userA, (log) => log.deleteEntry(entryId))).toBe(true);
    await asLogActor(ids.userA, async (_log, client) => {
      for (const table of ["meals_log_estimates", "meals_log_estimate_items"]) {
        const left = await client.query(`SELECT 1 FROM app.${table}`);
        expect(left.rowCount).toBe(0);
      }
    });
  });
});

describe("lock, regenerate and swap (S7 #3891)", () => {
  const recipe = (n: number, title: string) => ({
    recipeId: uuid(n),
    title,
    titleKey: title.toLowerCase(),
    steps: ["Cook."],
    cookMinutes: 20,
    baseServings: 2,
    kcalPerServing: 500,
    ingredients: [
      {
        originalText: "1 cup rice",
        name: "Rice",
        quantity: 1,
        unit: "cup",
        section: "pantry" as const,
        checkLabel: false
      }
    ]
  });

  async function readyMeal(base: number, key: string) {
    const seeded = await seedPlan(ids.userA, base, key);
    const dayId = seeded.days[0]!.dayId;
    const mealId = uuid(base + 10);
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.bumpDay(dayId))!;
      await plans.claimDay(dayId, generation);
      await plans.claimMeal(mealId, dayId, generation);
      await plans.saveMealReady({
        mealId,
        generation,
        attempts: 1,
        kitchenId: seeded.kitchenId,
        recipe: recipe(base + 100, `Original ${base}`),
        eaters: [
          {
            memberId: seeded.self,
            portion: 1,
            estimatedKcal: 500,
            safety: "pass",
            safetyReason: null
          }
        ]
      });
    });
    return { ...seeded, mealId, originalRecipeId: uuid(base + 100) };
  }

  it("locks a meal and resets only the replaceable ones", async () => {
    const seeded = await readyMeal(7000, "s7-lock");
    await asPlanActor(ids.userA, async (plans) => {
      expect(await plans.setMealLocked(seeded.mealId, true)).toBe(true);
      expect((await plans.getMeal(seeded.mealId))!.locked).toBe(true);
      expect(await plans.resetMeals([seeded.mealId])).toBe(0);
      expect((await plans.getMeal(seeded.mealId))!.status).toBe("ready");

      await plans.setMealLocked(seeded.mealId, false);
      expect(await plans.resetMeals([seeded.mealId])).toBe(1);
      const meal = (await plans.getMeal(seeded.mealId))!;
      expect(meal.status).toBe("pending");
      expect(meal.recipeId).toBe(seeded.originalRecipeId);
    });
  });

  it("stores three choices and puts the chosen one on the meal", async () => {
    const seeded = await readyMeal(7200, "s7-swap");
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.startMealJob(seeded.mealId))!;
      expect(generation).toBe(1);
      const choices = [1, 2, 3].map((position) => ({
        choiceId: uuid(7200 + 20 + position),
        position
      }));
      await plans.replaceSwapChoices(seeded.mealId, seeded.kitchenId, generation, choices);
      expect((await plans.listSwapChoices(seeded.mealId)).map((row) => row.status)).toEqual([
        "pending",
        "pending",
        "pending"
      ]);

      const first = choices[0]!.choiceId;
      expect(await plans.claimSwapChoice(first, generation + 1)).toBe(false);
      expect(await plans.claimSwapChoice(first, generation)).toBe(true);
      const saved = {
        choiceId: first,
        kitchenId: seeded.kitchenId,
        recipe: recipe(7390, "Swapped In")
      };
      expect(await plans.saveChoiceReady({ ...saved, generation: generation + 1 })).toBe(false);
      expect(await plans.saveChoiceReady({ ...saved, generation })).toBe(true);
      expect(await plans.claimSwapChoice(choices[1]!.choiceId, generation)).toBe(true);
      expect(await plans.failChoice(choices[1]!.choiceId, generation)).toBe(true);

      const eaters = [
        {
          memberId: seeded.self,
          portion: 1,
          estimatedKcal: 500,
          safety: "pass" as const,
          safetyReason: null
        }
      ];
      // A pending or failed choice cannot be chosen.
      expect(
        await plans.chooseSwap({ mealId: seeded.mealId, choiceId: choices[2]!.choiceId, eaters })
      ).toBe(false);
      expect(
        await plans.chooseSwap({ mealId: seeded.mealId, choiceId: choices[1]!.choiceId, eaters })
      ).toBe(false);
      expect(await plans.chooseSwap({ mealId: seeded.mealId, choiceId: first, eaters })).toBe(true);

      const meal = (await plans.getMeal(seeded.mealId))!;
      expect(meal).toMatchObject({ recipeId: uuid(7390), status: "ready" });
      expect(await plans.listSwapChoices(seeded.mealId)).toEqual([]);
    });
  });

  it("counts a new generation for each job and replaces the old choices", async () => {
    const seeded = await readyMeal(7400, "s7-gen");
    await asPlanActor(ids.userA, async (plans) => {
      expect(await plans.startMealJob(seeded.mealId)).toBe(1);
      expect(await plans.startMealJob(seeded.mealId)).toBe(2);
      expect(await plans.startMealJob(uuid(7499))).toBeNull();
      await plans.replaceSwapChoices(seeded.mealId, seeded.kitchenId, 1, [
        { choiceId: uuid(7421), position: 1 }
      ]);
      await plans.replaceSwapChoices(seeded.mealId, seeded.kitchenId, 2, [
        { choiceId: uuid(7431), position: 1 }
      ]);
      expect((await plans.listSwapChoices(seeded.mealId)).map((row) => row.choiceId)).toEqual([
        uuid(7431)
      ]);
    });
  });

  it("saves new Safety verdicts for current eaters, but not for a stale generation", async () => {
    const seeded = await readyMeal(7500, "s7-verdict");
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.startMealJob(seeded.mealId))!;
      const verdict = {
        memberId: seeded.self,
        portion: 1,
        estimatedKcal: 500,
        safety: "fail" as const,
        safetyReason: "peanut"
      };
      const meal = (await plans.getMeal(seeded.mealId))!;
      // A newer job raised the generation after this verdict was computed.
      await plans.startMealJob(seeded.mealId);
      expect(
        await plans.saveEaterVerdicts({
          mealId: seeded.mealId,
          generation,
          recipeId: meal.recipeId!,
          eaters: [verdict]
        })
      ).toBe(false);
      expect((await plans.getMeal(seeded.mealId))!.eaters[0]).toMatchObject({ safety: "pass" });

      // The current generation still saves.
      const current = (await plans.startMealJob(seeded.mealId))!;
      expect(
        await plans.saveEaterVerdicts({
          mealId: seeded.mealId,
          generation: current,
          recipeId: meal.recipeId!,
          eaters: [verdict]
        })
      ).toBe(true);
      expect((await plans.getMeal(seeded.mealId))!.eaters[0]).toMatchObject({
        safety: "fail",
        safetyReason: "peanut"
      });
    });
  });

  it("keeps a second owner away from the first owner's choices", async () => {
    const seeded = await readyMeal(7600, "s7-private");
    await asPlanActor(ids.userA, async (plans) => {
      await plans.replaceSwapChoices(seeded.mealId, seeded.kitchenId, 1, [
        { choiceId: uuid(7621), position: 1 }
      ]);
    });
    await asPlanActor(ids.userB, async (plans) => {
      expect(await plans.listSwapChoices(seeded.mealId)).toEqual([]);
      expect(await plans.claimSwapChoice(uuid(7621), 1)).toBe(false);
      expect(await plans.failChoice(uuid(7621), 1)).toBe(false);
      expect(await plans.setMealLocked(seeded.mealId, true)).toBe(false);
      expect(await plans.resetMeals([seeded.mealId])).toBe(0);
      expect(await plans.startMealJob(seeded.mealId)).toBeNull();
    });
    await asPlanActor(ids.userA, async (plans) => {
      expect(await plans.listSwapChoices(seeded.mealId)).toHaveLength(1);
    });
  });
});

describe("quick swap (S9 #3893)", () => {
  it("stores the cap, saves only under the current job generation, and keeps a second owner out", async () => {
    const seeded = await seedPlan(ids.userA, 8000, "s9-quick");
    const dayId = seeded.days[0]!.dayId;
    const mealId = uuid(8010);
    const recipe = (n: number, title: string) => ({
      recipeId: uuid(n),
      title,
      titleKey: title.toLowerCase(),
      steps: ["Cook."],
      cookMinutes: 10,
      baseServings: 2,
      kcalPerServing: 500,
      ingredients: [
        {
          originalText: "1 cup rice",
          name: "Rice",
          quantity: 1,
          unit: "cup",
          section: "pantry" as const,
          checkLabel: false
        }
      ]
    });
    const eaters = [
      {
        memberId: seeded.self,
        portion: 1,
        estimatedKcal: 500,
        safety: "pass" as const,
        safetyReason: null
      }
    ];
    await asPlanActor(ids.userA, async (plans) => {
      const generation = (await plans.bumpDay(dayId))!;
      await plans.claimDay(dayId, generation);
      await plans.claimMeal(mealId, dayId, generation);
      await plans.saveMealReady({
        mealId,
        generation,
        attempts: 1,
        kitchenId: seeded.kitchenId,
        recipe: recipe(8100, "Original 8000"),
        eaters
      });

      const first = (await plans.startQuickSwap(mealId, 15))!;
      const second = (await plans.startQuickSwap(mealId, 20))!;
      expect((await plans.getMeal(mealId))!.quickMaxMinutes).toBe(20);
      expect(await plans.claimQuickSwap(mealId, first)).toBe(false);
      expect(await plans.claimQuickSwap(mealId, second)).toBe(true);
      expect(
        await plans.saveQuickSwap({
          mealId,
          generation: first,
          kitchenId: seeded.kitchenId,
          recipe: recipe(8200, "Stale dish"),
          eaters,
          attempts: 1
        })
      ).toBe(false);
      expect(
        await plans.saveQuickSwap({
          mealId,
          generation: second,
          kitchenId: seeded.kitchenId,
          recipe: recipe(8300, "Quick dish"),
          eaters,
          attempts: 1
        })
      ).toBe(true);
      const meal = (await plans.getMeal(mealId))!;
      expect(meal.status).toBe("ready");
      expect(meal.quickMaxMinutes).toBe(20);
      expect(meal.recipeId).toBe(uuid(8300));
    });
    await asPlanActor(ids.userB, async (plans) => {
      expect(await plans.startQuickSwap(mealId, 15)).toBeNull();
      expect(await plans.claimQuickSwap(mealId, 3)).toBe(false);
    });
  });
});
