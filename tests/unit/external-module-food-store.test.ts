// tests/unit/external-module-food-store.test.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 7): sqlStore (external-modules/food/src/store/sql.ts)
// exercised against a fake FoodDb that faithfully reproduces the SQL text's semantics (CAS
// WHERE clauses, ON CONFLICT DO NOTHING, LEFT JOIN with the current-revision estimate) rather
// than a real Postgres connection — no DB-touching command runs in this suite. The fake is
// deliberately query-text-driven (it dispatches on substrings of the real SQL, not a rewritten
// abstraction) so it stays a test of THIS file's actual statements, not of a reinterpretation
// of them.
//
// Behaviours covered here (plan §4 Task 7):
//   2  Idempotent create — same idempotencyKey twice -> one row
//   7  Stale revision rejected — correctMeal with a behind expectedRevision writes nothing
//   13 Torn estimate write degrades safely — the CAS UPDATE on food_meals can succeed while the
//      INSERT on food_estimates fails (no transaction, R12); the meal must read back with no
//      estimate, never a partial/zeroed one, and a re-run of recordEstimate must complete it.
// pg numeric columns round-trip as strings — the fake returns them as strings, matching the real
// driver, so toNutrientNumber's coercion is exercised for real rather than trivially skipped.
import { describe, expect, it } from "vitest";

import type { Nutrients } from "../../external-modules/food/src/domain/meal.js";
import type { FoodDb } from "../../external-modules/food/src/store/sql.js";
import { sqlStore } from "../../external-modules/food/src/store/sql.js";

interface StoredMeal {
  meal_id: string;
  consumed_at: Date;
  local_date: string;
  timezone_offset: number;
  description: string;
  serving_note: string | null;
  capture_kind: string;
  estimate_state: string;
  estimate_revision: number;
  idempotency_key: string;
}

interface StoredEstimate {
  meal_id: string;
  revision: number;
  calories_kcal: string | null;
  protein_g: string | null;
  carbohydrates_g: string | null;
  fat_g: string | null;
  fiber_g: string | null;
  sugar_g: string | null;
  sodium_mg: string | null;
  missing_details: string | null;
}

/**
 * In-memory double for FoodDb that understands exactly the query shapes sql.ts issues.
 * `failNextEstimateInsert` simulates test 13's torn write: the food_meals CAS UPDATE commits,
 * then the very next INSERT INTO app.food_estimates throws — the "no transaction" reality R12
 * documents, since the host allows no BEGIN/COMMIT at all.
 */
function fakeDb(): FoodDb & {
  meals: Map<string, StoredMeal>;
  estimates: Map<string, StoredEstimate>;
  failNextEstimateInsert: boolean;
} {
  const meals = new Map<string, StoredMeal>();
  const estimates = new Map<string, StoredEstimate>(); // key: `${meal_id}:${revision}`
  const state = { failNextEstimateInsert: false };

  function mealRow(m: StoredMeal) {
    const est = estimates.get(`${m.meal_id}:${m.estimate_revision}`);
    return {
      meal_id: m.meal_id,
      consumed_at: m.consumed_at,
      local_date: m.local_date,
      timezone_offset: m.timezone_offset,
      description: m.description,
      serving_note: m.serving_note,
      capture_kind: m.capture_kind,
      estimate_state: m.estimate_state,
      estimate_revision: m.estimate_revision,
      calories_kcal: est?.calories_kcal ?? null,
      protein_g: est?.protein_g ?? null,
      carbohydrates_g: est?.carbohydrates_g ?? null,
      fat_g: est?.fat_g ?? null,
      fiber_g: est?.fiber_g ?? null,
      sugar_g: est?.sugar_g ?? null,
      sodium_mg: est?.sodium_mg ?? null,
      missing_details: est?.missing_details ?? null
    };
  }

  return {
    meals,
    estimates,
    get failNextEstimateInsert() {
      return state.failNextEstimateInsert;
    },
    set failNextEstimateInsert(value: boolean) {
      state.failNextEstimateInsert = value;
    },
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []) {
      // createMeal: INSERT ... ON CONFLICT (owner_user_id, idempotency_key) DO NOTHING RETURNING ...
      if (text.includes("INSERT INTO app.food_meals") && text.includes("ON CONFLICT")) {
        const [
          mealId,
          consumedAt,
          localDate,
          timezoneOffset,
          description,
          servingNote,
          captureKind,
          idempotencyKey
        ] = params as [string, Date, string, number, string, string | null, string, string];
        const conflict = [...meals.values()].some((m) => m.idempotency_key === idempotencyKey);
        if (conflict) return { rows: [] as T[] };
        const row: StoredMeal = {
          meal_id: mealId,
          consumed_at: consumedAt,
          local_date: localDate,
          timezone_offset: timezoneOffset,
          description,
          serving_note: servingNote,
          capture_kind: captureKind,
          estimate_state: "pending",
          estimate_revision: 0,
          idempotency_key: idempotencyKey
        };
        meals.set(mealId, row);
        return { rows: [mealRow(row) as unknown as T] };
      }

      // createMeal's idempotency-conflict fallback SELECT.
      if (text.includes("WHERE m.idempotency_key = $1")) {
        const [idempotencyKey] = params as [string];
        const found = [...meals.values()].find((m) => m.idempotency_key === idempotencyKey);
        return { rows: found ? [mealRow(found) as unknown as T] : [] };
      }

      // recordEstimate / correctMeal's CAS UPDATE on food_meals.
      if (text.includes("UPDATE app.food_meals") && text.includes("estimate_state = $3")) {
        const [mealId, expectedRevision, newState] = params as [string, number, string];
        const row = meals.get(mealId);
        if (!row || row.estimate_revision !== expectedRevision) return { rows: [] as T[] };
        row.estimate_state = newState;
        row.estimate_revision += 1;
        return { rows: [{ estimate_revision: row.estimate_revision } as unknown as T] };
      }

      // recordEstimate's INSERT INTO app.food_estimates.
      if (
        text.includes("INSERT INTO app.food_estimates") &&
        text.includes("clarification_question")
      ) {
        if (state.failNextEstimateInsert) {
          state.failNextEstimateInsert = false;
          throw new Error("simulated: food_estimates insert failed after food_meals CAS committed");
        }
        const [
          mealId,
          revision,
          calories,
          protein,
          carbs,
          fat,
          fiber,
          sugar,
          sodium,
          missingDetails
        ] = params as [string, number, ...unknown[]];
        estimates.set(`${mealId}:${revision}`, {
          meal_id: mealId,
          revision,
          calories_kcal: calories === null ? null : String(calories),
          protein_g: protein === null ? null : String(protein),
          carbohydrates_g: carbs === null ? null : String(carbs),
          fat_g: fat === null ? null : String(fat),
          fiber_g: fiber === null ? null : String(fiber),
          sugar_g: sugar === null ? null : String(sugar),
          sodium_mg: sodium === null ? null : String(sodium),
          missing_details: missingDetails as string | null
        });
        return { rows: [] as T[] };
      }

      // correctMeal's own field-update UPDATE (description/consumed_at/... COALESCE).
      if (text.includes("UPDATE app.food_meals") && text.includes("description = COALESCE")) {
        const [
          mealId,
          expectedRevision,
          description,
          consumedAt,
          localDate,
          timezoneOffset,
          nextState
        ] = params as [
          string,
          number,
          string | null,
          Date | null,
          string | null,
          number | null,
          string
        ];
        const row = meals.get(mealId);
        if (!row || row.estimate_revision !== expectedRevision) return { rows: [] as T[] };
        if (description !== null) row.description = description;
        if (consumedAt !== null) row.consumed_at = consumedAt;
        if (localDate !== null) row.local_date = localDate;
        if (timezoneOffset !== null) row.timezone_offset = timezoneOffset;
        row.estimate_state = nextState;
        row.estimate_revision += 1;
        return { rows: [{ estimate_revision: row.estimate_revision } as unknown as T] };
      }

      // correctMeal's merged-nutrients INSERT (no clarification_question param -> always NULL).
      if (
        text.includes("INSERT INTO app.food_estimates") &&
        text.includes(
          "VALUES (app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL)"
        )
      ) {
        const [mealId, revision, calories, protein, carbs, fat, fiber, sugar, sodium] = params as [
          string,
          number,
          ...unknown[]
        ];
        estimates.set(`${mealId}:${revision}`, {
          meal_id: mealId,
          revision,
          calories_kcal: calories === null ? null : String(calories),
          protein_g: protein === null ? null : String(protein),
          carbohydrates_g: carbs === null ? null : String(carbs),
          fat_g: fat === null ? null : String(fat),
          fiber_g: fiber === null ? null : String(fiber),
          sugar_g: sugar === null ? null : String(sugar),
          sodium_mg: sodium === null ? null : String(sodium),
          missing_details: null
        });
        return { rows: [] as T[] };
      }

      // getMeal / recordEstimate's / correctMeal's read-back: `${JOIN} WHERE m.meal_id = $1`
      if (text.includes("WHERE m.meal_id = $1")) {
        const [mealId] = params as [string];
        const row = meals.get(mealId);
        return { rows: row ? [mealRow(row) as unknown as T] : [] };
      }

      // listMealsForLocalDate
      if (text.includes("WHERE m.local_date = $1")) {
        const [localDate] = params as [string];
        const rows = [...meals.values()]
          .filter((m) => m.local_date === localDate)
          .sort((a, b) => a.consumed_at.getTime() - b.consumed_at.getTime())
          .map((m) => mealRow(m) as unknown as T);
        return { rows };
      }

      // listMealsForDateRange
      if (text.includes("WHERE m.local_date BETWEEN")) {
        const [from, to] = params as [string, string];
        const rows = [...meals.values()]
          .filter((m) => m.local_date >= from && m.local_date <= to)
          .sort((a, b) => a.consumed_at.getTime() - b.consumed_at.getTime())
          .map((m) => mealRow(m) as unknown as T);
        return { rows };
      }

      // deleteMeal
      if (text.includes("DELETE FROM app.food_meals")) {
        const [mealId] = params as [string];
        const existed = meals.delete(mealId);
        return { rows: existed ? [{ meal_id: mealId } as unknown as T] : [] };
      }

      throw new Error(`fakeDb: unrecognized query: ${text.slice(0, 80)}`);
    }
  };
}

function baseNutrients(overrides: Partial<Nutrients> = {}): Nutrients {
  return {
    caloriesKcal: 350,
    proteinG: 10,
    carbohydratesG: 65,
    fatG: 6,
    fiberG: 8,
    sugarG: 20,
    sodiumMg: 150,
    ...overrides
  };
}

describe("sqlStore.createMeal (plan §4 Task 7 test 2: idempotent create)", () => {
  it("same idempotencyKey twice returns the SAME existing row, not a duplicate", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const input = {
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text" as const,
      idempotencyKey: "idem-1"
    };
    const first = await store.createMeal(input);
    // A retry after a timed-out request: same idempotencyKey, even a different mealId (the
    // caller generates a fresh UUID per attempt) — the unique constraint on
    // (owner_user_id, idempotency_key) is what makes this collide, not the mealId.
    const second = await store.createMeal({ ...input, mealId: "meal-1-retry" });
    expect(second.mealId).toBe(first.mealId);
    expect(db.meals.size).toBe(1);
  });
});

describe("sqlStore CAS guards (plan §4 Task 7 test 7: stale revision rejected)", () => {
  it("correctMeal with a stale expectedRevision writes nothing and returns null", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "original description",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    // A correction that raced ahead already bumped the revision once.
    await store.correctMeal(meal.mealId, meal.estimateRevision, { description: "first edit" });

    // Now retry against the STALE (original) revision — simulating an async estimate write
    // that started before the user's own correction landed.
    const rejected = await store.correctMeal(meal.mealId, meal.estimateRevision, {
      description: "should never land"
    });
    expect(rejected).toBeNull();

    const current = await store.getMeal(meal.mealId);
    expect(current?.description).toBe("first edit");
    expect(current?.description).not.toBe("should never land");
  });

  it("recordEstimate with a stale expectedRevision is a no-op (null), not an overwrite", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    // Correct it first (bumps revision to 1), THEN try to record an estimate against the
    // now-stale original revision 0 — mirrors the queue retry racing a user correction.
    await store.correctMeal(meal.mealId, meal.estimateRevision, { description: "corrected" });
    const result = await store.recordEstimate(meal.mealId, meal.estimateRevision, {
      state: "estimated",
      nutrients: baseNutrients(),
      missingDetails: null,
      clarificationQuestion: null
    });
    expect(result).toBeNull();
    const current = await store.getMeal(meal.mealId);
    expect(current?.estimateState).not.toBe("estimated");
  });
});

describe("sqlStore.recordEstimate torn write (plan §4 Task 7 test 13)", () => {
  it("degrades safely when food_estimates INSERT fails after the food_meals CAS committed", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });

    db.failNextEstimateInsert = true;
    await expect(
      store.recordEstimate(meal.mealId, meal.estimateRevision, {
        state: "estimated",
        nutrients: baseNutrients(),
        missingDetails: null,
        clarificationQuestion: null
      })
    ).rejects.toThrow();

    // The food_meals CAS UPDATE already committed (estimate_state='estimated',
    // revision incremented) before the throw — that write is real and cannot be undone
    // without a transaction (R12). The meal must read back with NO estimate at all (every
    // nutrient null), never a partial or zeroed record — a broken mapper that assumes an
    // estimate row always exists for the current revision would throw or render zeros here.
    const torn = await store.getMeal(meal.mealId);
    expect(torn).not.toBeNull();
    expect(torn?.estimateState).toBe("estimated");
    expect(torn?.nutrients).toEqual({
      caloriesKcal: null,
      proteinG: null,
      carbohydratesG: null,
      fatG: null,
      fiberG: null,
      sugarG: null,
      sodiumMg: null
    });

    // Re-running the estimate queue against the NEW (post-CAS) revision completes it —
    // this is the retry path's actual contract (worker/handlers/estimate.ts re-reads the
    // meal and uses its current revision, not the stale pre-CAS one).
    const recovered = await store.recordEstimate(meal.mealId, torn!.estimateRevision, {
      state: "estimated",
      nutrients: baseNutrients(),
      missingDetails: null,
      clarificationQuestion: null
    });
    expect(recovered?.nutrients).toEqual(baseNutrients());
  });
});

describe("sqlStore nutrient round-trip (pg numeric-as-string)", () => {
  it("coerces string numeric columns to numbers, preserving null", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    await store.recordEstimate(meal.mealId, meal.estimateRevision, {
      state: "estimated",
      nutrients: baseNutrients({ sodiumMg: null }),
      missingDetails: null,
      clarificationQuestion: null
    });
    // The fake stores nutrient columns as strings (matching pg's numeric(...) round-trip) —
    // asserting typeof number here proves toNutrientNumber actually ran.
    const stored = db.estimates.get(`${meal.mealId}:1`)!;
    expect(typeof stored.calories_kcal).toBe("string");

    const result = await store.getMeal(meal.mealId);
    expect(typeof result?.nutrients?.caloriesKcal).toBe("number");
    expect(result?.nutrients?.caloriesKcal).toBe(350);
    expect(result?.nutrients?.sodiumMg).toBeNull();
  });
});

describe("sqlStore.correctMeal nutrient merge", () => {
  it("merges a partial nutrient patch over the current estimate, never blanking unspecified fields", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    const estimated = await store.recordEstimate(meal.mealId, meal.estimateRevision, {
      state: "estimated",
      nutrients: baseNutrients(),
      missingDetails: null,
      clarificationQuestion: null
    });
    const corrected = await store.correctMeal(meal.mealId, estimated!.estimateRevision, {
      nutrients: { caloriesKcal: 500 }
    });
    expect(corrected?.nutrients?.caloriesKcal).toBe(500);
    // Everything else the user didn't touch survives the correction unchanged.
    expect(corrected?.nutrients?.proteinG).toBe(baseNutrients().proteinG);
    expect(corrected?.nutrients?.sodiumMg).toBe(baseNutrients().sodiumMg);
  });
});

describe("sqlStore.deleteMeal", () => {
  it("returns true when a row existed, false otherwise", async () => {
    const db = fakeDb();
    const store = sqlStore(db);
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date("2026-07-18T12:00:00.000Z"),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    expect(await store.deleteMeal(meal.mealId)).toBe(true);
    expect(await store.deleteMeal(meal.mealId)).toBe(false);
    expect(await store.getMeal(meal.mealId)).toBeNull();
  });
});
