// tests/unit/external-module-food-handlers.test.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 7): the tools/worker handler layer
// (external-modules/food/src/tools/meals.ts,
// src/worker/handlers/estimate.ts) exercised against a FakeFoodStore (implements the
// FoodStore interface's documented CAS/idempotency contract in memory) and fake
// kv/ai ports matching ModuleWorkerContext's structural shape — no db, no real SQL.
//
// Behaviours from the plan:
//   1  Meal persists before estimation — a provider blip never loses the meal
//   2  Idempotent create — a retry never re-triggers estimation (handler-level half;
//      store-level half is in external-module-food-store.test.ts)
//   7  Stale revision rejected — handler propagates the store's null correctly
//   8  AI-estimates gate BEFORE any provider call (#1750)
//   9  Two-actor privacy — cannot verify RLS here (needs real Postgres); handlers never
//      accept a caller-supplied owner id is asserted structurally (no ownerUserId/actorUserId
//      read anywhere in tools/meals.ts — grep assertion below)
//  11  No content in logs — grep assertion: no console.* call in src/ ever interpolates
//      description/nutrients/servingNote
//  14  Empty day (food.meals.list totals) — covered against the real computeDailyTotals
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { Meal, MealItem, Nutrients } from "../../external-modules/food/src/domain/meal.js";
import { sumItemNutrients } from "../../external-modules/food/src/domain/totals.js";
import {
  createMealsCorrectHandler,
  createMealsListHandler,
  createMealsLogHandler,
  createMealsReestimateHandler
} from "../../external-modules/food/src/tools/meals.js";
import { InputError } from "../../external-modules/food/src/tools/validate.js";
import { runEstimate } from "../../external-modules/food/src/worker/handlers/estimate.js";
import type {
  CorrectMealItemPatch,
  CorrectMealPatch,
  CreateMealInput,
  FoodStore,
  RecordEstimateInput
} from "../../external-modules/food/src/store/sql.js";

// ── Fakes ────────────────────────────────────────────────────────────────

/** Positional item merge, mirroring store/sql.ts's mergeItems. */
function mergeFakeItems(
  current: readonly MealItem[],
  patch: readonly CorrectMealItemPatch[]
): MealItem[] {
  const length = Math.max(current.length, patch.length);
  const merged: MealItem[] = [];
  for (let index = 0; index < length; index += 1) {
    const base = current[index];
    const change = patch[index];
    if (!change) {
      if (base) merged.push(base);
      continue;
    }
    merged.push({
      label: change.label ?? base?.label ?? "item",
      portionNote:
        change.portionNote !== undefined ? change.portionNote : (base?.portionNote ?? null),
      nutrients: { ...(base?.nutrients ?? nullNutrients()), ...change.nutrients }
    });
  }
  return merged;
}

/** In-memory FoodStore double reproducing sql.ts's documented contract: createMeal is
 * idempotent on idempotencyKey (returns the existing row on a retry); recordEstimate and
 * correctMeal are CAS-guarded on expectedRevision and return null on a stale/missing meal. */
function fakeStore(): FoodStore & { meals: Map<string, Meal> } {
  const meals = new Map<string, Meal>();
  const byIdempotencyKey = new Map<string, string>();

  return {
    meals,
    async createMeal(input: CreateMealInput) {
      const existingId = byIdempotencyKey.get(input.idempotencyKey);
      if (existingId) return meals.get(existingId)!;
      const meal: Meal = {
        items: [],
        mealId: input.mealId,
        consumedAt: input.consumedAt.toISOString(),
        localDate: input.localDate,
        timezoneOffset: input.timezoneOffset,
        description: input.description,
        servingNote: input.servingNote,
        captureKind: input.captureKind,
        estimateState: "pending",
        estimateRevision: 0,
        nutrients: null,
        missingDetails: null
      };
      meals.set(meal.mealId, meal);
      byIdempotencyKey.set(input.idempotencyKey, meal.mealId);
      return meal;
    },
    async getMeal(mealId: string) {
      return meals.get(mealId) ?? null;
    },
    async listMealsForLocalDate(localDate: string) {
      return [...meals.values()]
        .filter((m) => m.localDate === localDate)
        .sort((a, b) => a.consumedAt.localeCompare(b.consumedAt));
    },
    async listMealsForDateRange(from: string, to: string) {
      return [...meals.values()]
        .filter((m) => m.localDate >= from && m.localDate <= to)
        .sort((a, b) => a.consumedAt.localeCompare(b.consumedAt));
    },
    async recordEstimate(mealId: string, expectedRevision: number, outcome: RecordEstimateInput) {
      const meal = meals.get(mealId);
      if (!meal || meal.estimateRevision !== expectedRevision) return null;
      const updated: Meal = {
        ...meal,
        estimateState: outcome.state,
        estimateRevision: meal.estimateRevision + 1,
        nutrients: outcome.state === "estimated" ? outcome.nutrients : null,
        missingDetails: outcome.state === "needs_details" ? outcome.missingDetails : null
      };
      meals.set(mealId, updated);
      return updated;
    },
    async correctMeal(mealId: string, expectedRevision: number, patch: CorrectMealPatch) {
      const meal = meals.get(mealId);
      if (!meal || meal.estimateRevision !== expectedRevision) return null;
      // Item-level correction (#1737): entry N patches the Nth food, and the meal's
      // figures are re-derived from the result — this double never stores a
      // meal-level number the items do not explain.
      const items = patch.items ? mergeFakeItems(meal.items, patch.items) : meal.items;
      const nutrients = patch.items ? sumItemNutrients(items) : meal.nutrients;
      const updated: Meal = {
        ...meal,
        description: patch.description ?? meal.description,
        consumedAt: patch.consumedAt ? patch.consumedAt.toISOString() : meal.consumedAt,
        localDate: patch.localDate ?? meal.localDate,
        timezoneOffset: patch.timezoneOffset ?? meal.timezoneOffset,
        estimateState: patch.items ? "estimated" : meal.estimateState,
        estimateRevision: meal.estimateRevision + 1,
        items,
        nutrients
      };
      meals.set(mealId, updated);
      return updated;
    },
    async deleteMeal(mealId: string) {
      return meals.delete(mealId);
    }
  };
}

function nullNutrients(): Nutrients {
  return {
    caloriesKcal: null,
    proteinG: null,
    carbohydratesG: null,
    fatG: null,
    fiberG: null,
    sugarG: null,
    sodiumMg: null
  };
}

/** Fake kv keyed by `${scope}:${namespace}:${key}`. Retained for handlers that still use module
 * storage; the AI-estimates gate reads ctx.preferences, not kv (#1750). */
function fakeKv() {
  const store = new Map<string, Record<string, unknown>>();
  const kv = {
    get: vi.fn(async (scope: string, namespace: string, key: string) => {
      return store.get(`${scope}:${namespace}:${key}`) ?? null;
    }),
    set: vi.fn(
      async (scope: string, namespace: string, key: string, value: Record<string, unknown>) => {
        store.set(`${scope}:${namespace}:${key}`, value);
      }
    ),
    delete: vi.fn(async () => true),
    list: vi.fn(async () => [] as string[])
  };
  return kv;
}

type AiResult =
  | { ok: true; object: unknown }
  | {
      ok: false;
      error: "needs_config" | "validation_failed" | "provider_error" | "usage_limited" | "aborted";
    };

function fakeAi(impl: () => AiResult | Promise<AiResult>) {
  return { generateStructured: vi.fn(async () => impl()) };
}

function baseCtx(overrides: {
  input?: Record<string, unknown>;
  kv?: ReturnType<typeof fakeKv>;
  ai?: ReturnType<typeof fakeAi>;
  /** #1750 — omit to model "user has never touched the switch", which must estimate. */
  preferences?: Record<string, boolean>;
  /** #1789 — omit to model a host that has no locale for this user, which must not crash. */
  localTimezone?: string;
}) {
  return {
    input: overrides.input ?? {},
    preferences: overrides.preferences ?? {},
    ...(overrides.localTimezone ? { localTimezone: overrides.localTimezone } : {}),
    deadlineAt: Date.now() + 30_000,
    auth: { getCredential: vi.fn(), setCredential: vi.fn() },
    fetch: vi.fn(),
    kv: overrides.kv ?? fakeKv(),
    ai: overrides.ai ?? fakeAi(() => ({ ok: false, error: "provider_error" })),
    db: { query: vi.fn(async () => ({ rows: [] })) },
    embed: { embedDocuments: vi.fn(), embedQuery: vi.fn(), dimensions: vi.fn() },
    attachments: { readText: vi.fn(async () => null) },
    notify: { post: vi.fn(async () => undefined) }
  } as unknown as Parameters<ReturnType<typeof createMealsLogHandler>>[0];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("food.meals.log — test 8: AI-estimates gate before any provider call (#1750)", () => {
  it("switch off: meal saves pending, ai.generateStructured is never called", async () => {
    const store = fakeStore();
    const ai = fakeAi(() => ({ ok: true, object: {} }));
    const ctx = baseCtx({
      input: { description: "a bowl of oatmeal", idempotencyKey: "idem-1" },
      ai,
      preferences: { aiEstimates: false }
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(result.meal.estimateState).toBe("pending");
    expect(ai.generateStructured).not.toHaveBeenCalled();
  });

  it("switch untouched: the provider is called, because the manifest default is on", async () => {
    const store = fakeStore();
    const kv = fakeKv();
    const ai = fakeAi(() => ({
      ok: true,
      object: {
        outcome: "estimated",
        items: [
          {
            label: "oatmeal",
            portionNote: "1 bowl",
            caloriesKcal: 350,
            proteinG: 10,
            carbohydratesG: 65,
            fatG: 6,
            fiberG: 8,
            sugarG: 20,
            sodiumMg: 150
          }
        ],
        missingDetails: null,
        clarificationQuestion: null
      }
    }));
    const ctx = baseCtx({
      input: { description: "a bowl of oatmeal", idempotencyKey: "idem-1" },
      kv,
      ai
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(ai.generateStructured).toHaveBeenCalledTimes(1);
    expect(result.meal.estimateState).toBe("estimated");
    expect(result.meal.nutrients?.caloriesKcal).toBe(350);
  });
});

describe("food.meals.log — test 1: meal persists before/despite estimation failure", () => {
  it("a typed provider error still leaves the meal persisted, now 'failed'", async () => {
    const store = fakeStore();
    const kv = fakeKv();
    const ai = fakeAi(() => ({ ok: false, error: "provider_error" }));
    const ctx = baseCtx({
      input: { description: "a bowl of oatmeal", idempotencyKey: "idem-1" },
      kv,
      ai
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(result.meal.estimateState).toBe("failed");
    expect(result.meal.nutrients).toBeNull();
    // The row is durably there — a fresh read confirms it, not just the handler's return value.
    expect(await store.getMeal(result.meal.mealId)).not.toBeNull();
  });

  it("an actual throw from the provider call still leaves the meal row behind", async () => {
    // Simulates the "provider blip" the plan's fails-if clause targets literally: the meal
    // insert (store.createMeal) has ALREADY been awaited and returned before estimation is
    // even attempted — so even though this call rejects, the meal is not lost.
    const store = fakeStore();
    const kv = fakeKv();
    const ai = {
      generateStructured: vi.fn(async () => {
        throw new Error("network blip");
      })
    };
    const ctx = baseCtx({
      input: { description: "a bowl of oatmeal", idempotencyKey: "idem-1" },
      kv,
      ai
    });
    await expect(createMealsLogHandler(store)(ctx)).rejects.toThrow("network blip");
    expect(store.meals.size).toBe(1);
    const [meal] = [...store.meals.values()];
    expect(meal?.estimateState).toBe("pending"); // recordEstimate never ran
  });
});

describe("food.meals.log — test 2 (handler half): idempotent create never double-estimates", () => {
  it("a retry with the same idempotencyKey returns the existing row and does not call ai again", async () => {
    const store = fakeStore();
    const kv = fakeKv();
    let calls = 0;
    const ai = fakeAi(() => {
      calls += 1;
      return {
        ok: true,
        object: {
          outcome: "estimated",
          caloriesKcal: 100,
          proteinG: 1,
          carbohydratesG: 1,
          fatG: 1,
          fiberG: 1,
          sugarG: 1,
          sodiumMg: 1,
          missingDetails: null,
          clarificationQuestion: null
        }
      };
    });
    const handler = createMealsLogHandler(store);
    const first = await handler(
      baseCtx({ input: { description: "lunch", idempotencyKey: "idem-1" }, kv, ai })
    );
    const second = await handler(
      baseCtx({ input: { description: "lunch", idempotencyKey: "idem-1" }, kv, ai })
    );
    expect(second.meal.mealId).toBe(first.meal.mealId);
    expect(calls).toBe(1); // NOT called again on the retry — isFreshRow guards this
    expect(store.meals.size).toBe(1);
  });
});

describe("food.meals.reestimate / worker estimate.run — test 7: stale revision rejected", () => {
  it("reestimate handler leaves an already-estimated meal alone", async () => {
    const store = fakeStore();
    await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date(),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    await store.recordEstimate("meal-1", 0, {
      state: "estimated",
      items: [
        { label: "lunch", portionNote: null, nutrients: { ...nullNutrients(), caloriesKcal: 400 } }
      ],
      nutrients: { ...nullNutrients(), caloriesKcal: 400 },
      missingDetails: null,
      clarificationQuestion: null
    });
    const kv = fakeKv();
    const ai = fakeAi(() => ({ ok: true, object: {} }));
    const ctx = baseCtx({ input: { mealId: "meal-1" }, kv, ai });
    const result = await createMealsReestimateHandler(store)(ctx);
    expect(result.meal.estimateState).toBe("estimated");
    expect(ai.generateStructured).not.toHaveBeenCalled(); // already estimated: no re-roll
  });
});

describe("food.meals.list — test 14: empty day names its date (handler-level)", () => {
  it("localDate shape with no meals returns totals naming that date, not null/omitted", async () => {
    const store = fakeStore();
    const ctx = baseCtx({ input: { localDate: "2026-07-20" } });
    const result = await createMealsListHandler(store)(ctx);
    expect(result.meals).toEqual([]);
    // Zero meals is not "incomplete" (nothing failed to estimate) — it just names its date.
    expect(result.totals).toEqual({
      localDate: "2026-07-20",
      nutrients: nullNutrients(),
      incomplete: false,
      mealsWithoutEstimate: 0
    });
  });
});

// #1723 item 3. The range shape can span 31 days, and before this there was no cap on how many
// meals came back — the assistant-tool path pastes every one of them into a model context, so an
// ordinary "how did I eat last month" question could quietly cost hundreds of rows.
describe("food.meals.list — limit (#1723 item 3)", () => {
  /** Seeds `count` meals on `localDate`, one per minute, so consumed_at order is unambiguous. */
  function seedMeals(store: ReturnType<typeof fakeStore>, localDate: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const mealId = `meal-${localDate}-${String(i).padStart(3, "0")}`;
      store.meals.set(mealId, {
        items: [],
        mealId,
        consumedAt: `${localDate}T${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00.000Z`,
        localDate,
        timezoneOffset: 0,
        description: `meal ${i}`,
        servingNote: null,
        captureKind: "text",
        estimateState: "pending",
        estimateRevision: 0,
        nutrients: null,
        missingDetails: null
      });
    }
  }

  it("returns everything and says so when the day fits under the limit", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 3);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { localDate: "2026-07-20" } })
    );
    expect(result.meals).toHaveLength(3);
    // Not merely falsy: a caller reading `truncated` has to be able to trust the negative case.
    expect(result.truncated).toBe(false);
    expect(result.totalCount).toBe(3);
  });

  it("caps the list at the requested limit and reports the true count", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 10);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { localDate: "2026-07-20", limit: 4 } })
    );
    expect(result.meals).toHaveLength(4);
    expect(result.truncated).toBe(true);
    // Without this the caller cannot tell how much it is missing, only that it is missing some.
    expect(result.totalCount).toBe(10);
  });

  it("keeps the most recent meals, not the oldest", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 10);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { localDate: "2026-07-20", limit: 3 } })
    );
    // Truncating from the front would answer a month-range question with only its oldest days,
    // which is the opposite of what anyone asking about their eating wants.
    expect(result.meals.map((m) => m.description)).toEqual(["meal 7", "meal 8", "meal 9"]);
  });

  it("totals the whole day even when the meal list is truncated", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 10);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { localDate: "2026-07-20", limit: 2 } })
    );
    // The user compares this number against a target. A total computed over two of ten meals is a
    // wrong number presented as a right one.
    expect(result.totals?.mealsWithoutEstimate).toBe(10);
  });

  it("defaults to 200 when no limit is given", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 205);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { localDate: "2026-07-20" } })
    );
    expect(result.meals).toHaveLength(200);
    expect(result.truncated).toBe(true);
    expect(result.totalCount).toBe(205);
  });

  it("applies the limit to the range shape too", async () => {
    const store = fakeStore();
    seedMeals(store, "2026-07-20", 3);
    seedMeals(store, "2026-07-21", 3);
    const result = await createMealsListHandler(store)(
      baseCtx({ input: { fromLocalDate: "2026-07-20", toLocalDate: "2026-07-21", limit: 2 } })
    );
    expect(result.meals).toHaveLength(2);
    expect(result.totalCount).toBe(6);
    // The range shape has no single day to total, limit or no limit.
    expect(result.totals).toBeNull();
  });

  it.each([0, -1, 201, 1.5])("refuses the out-of-range limit %o", async (bad) => {
    const store = fakeStore();
    // Clamping silently would let the caller believe it had the whole set. Refusing says so.
    await expect(
      createMealsListHandler(store)(baseCtx({ input: { localDate: "2026-07-20", limit: bad } }))
    ).rejects.toThrow(InputError);
  });
});

describe("worker estimate.run handler (queue retry path)", () => {
  it("the estimates switch is checked before any provider call here too (#1750)", async () => {
    const store = fakeStore();
    const meal = await store.createMeal({
      mealId: "meal-1",
      consumedAt: new Date(),
      localDate: "2026-07-18",
      timezoneOffset: 0,
      description: "lunch",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1"
    });
    const kv = fakeKv();
    const ai = fakeAi(() => ({ ok: true, object: {} }));
    const db = {
      query: vi.fn(async (text: string, params: readonly unknown[] = []) => {
        // Minimal db double: estimate.run builds its own sqlStore(ctx.db) directly, so this
        // handler needs a REAL FoodDb-shaped fake, not our FoodStore fake. Route getMeal only.
        if (text.includes("WHERE m.meal_id = $1")) {
          const [mealId] = params as [string];
          if (mealId !== meal.mealId) return { rows: [] };
          return {
            rows: [
              {
                meal_id: meal.mealId,
                consumed_at: new Date(meal.consumedAt),
                local_date: meal.localDate,
                timezone_offset: meal.timezoneOffset,
                description: meal.description,
                serving_note: meal.servingNote,
                capture_kind: meal.captureKind,
                estimate_state: meal.estimateState,
                // Queue params require revision >= 1 (paramsSchema min:1) — the queue only ever
                // targets a meal AFTER a first synchronous attempt already bumped its revision
                // off 0 (meals.log's isFreshRow handles revision 0 inline), so this fixture
                // reports revision 1 to match the revision:1 this test sends below.
                estimate_revision: 1,
                calories_kcal: null,
                protein_g: null,
                carbohydrates_g: null,
                fat_g: null,
                fiber_g: null,
                sugar_g: null,
                sodium_mg: null,
                missing_details: null
              }
            ]
          };
        }
        // The estimate handler reads the meal back through the real store, which now
        // also asks for its item breakdown; this fixture's meal has none.
        if (text.includes("FROM app.food_estimate_items i")) {
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${text}`);
      })
    };
    const ctx = baseCtx({
      input: { mealId: meal.mealId, revision: 1 },
      kv,
      ai,
      preferences: { aiEstimates: false }
    });
    (ctx as unknown as { db: typeof db }).db = db;
    const result = await runEstimate(ctx);
    expect(result).toEqual({ status: "no-op", reason: "ai_estimates_disabled" });
    expect(ai.generateStructured).not.toHaveBeenCalled();
  });
});

// ── Static / grep assertions ────────────────────────────────────────────

const foodSrcDir = fileURLToPath(new URL("../../external-modules/food/src", import.meta.url));

function walkTsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walkTsFiles(full);
    return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [full] : [];
  });
}

describe("test 11: no meal content in logs or payloads (static grep)", () => {
  it("no console.* call in src/ interpolates description/nutrients/servingNote", () => {
    const files = walkTsFiles(foodSrcDir);
    expect(files.length).toBeGreaterThan(5);
    const consoleCallRe = /console\.(log|error|warn|info|debug)\(([^;]*)\)/gs;
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(consoleCallRe)) {
        const args = match[2] ?? "";
        if (/\bdescription\b|\bnutrients\b|\bservingNote\b|\bmeal\.description\b/.test(args)) {
          offenders.push(`${file}: ${match[0].slice(0, 120)}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("test 9 (structural half): no handler reads a caller-supplied owner id", () => {
  it("tools/meals.ts never reads ownerUserId/actorUserId off ctx.input", () => {
    // Real two-actor privacy is an RLS property (app.current_actor_user_id() in sql.ts) that
    // needs a live Postgres instance to prove end to end — out of reach for this unit suite.
    // This is the structural half: no handler here even HAS a caller-supplied owner id to
    // trust, because none of them read one off input.
    const source = readFileSync(join(foodSrcDir, "tools/meals.ts"), "utf8");
    expect(source).not.toMatch(/input\["?ownerUserId"?\]|input\.ownerUserId/);
    expect(source).not.toMatch(/input\["?actorUserId"?\]|input\.actorUserId/);
  });
});

// ── #1789: which timezone decides the calendar day ───────────────────────
//
// The bug these cover: a meal is filed under the localDate computed at log time, and the day
// view queries by exactly that field. Get the zone wrong and the meal is not merely mislabelled
// — it disappears from the day the user ate it and shows up on a day they did not.
//
// Every case below picks an instant deliberately: 2026-08-19T02:30:00Z is the 19th in UTC and
// still the 18th anywhere west of it. So "which day did this land on" separates a host-supplied
// zone from a model-supplied one from the UTC fallback, which a midday instant would not.
describe("food.meals.log — the user's timezone decides the day (#1789)", () => {
  const LATE_EVENING_IN_CHICAGO = "2026-08-19T02:30:00Z";

  it("files the meal on the user's day, not the server's", async () => {
    const store = fakeStore();
    const ctx = baseCtx({
      input: {
        description: "late dinner",
        idempotencyKey: "idem-tz-1",
        consumedAt: LATE_EVENING_IN_CHICAGO
      },
      localTimezone: "America/Chicago",
      preferences: { aiEstimates: false }
    });
    const result = await createMealsLogHandler(store)(ctx);
    // 02:30Z on the 19th is 21:30 on the 18th in Chicago. Before this fix the handler had no
    // way to know that and stored "2026-08-19", so the meal vanished from the 18th.
    expect(result.meal.localDate).toBe("2026-08-18");
  });

  it("uses the host's zone over one the model supplied, because the host's is a fact", async () => {
    const store = fakeStore();
    const ctx = baseCtx({
      input: {
        description: "late dinner",
        idempotencyKey: "idem-tz-2",
        consumedAt: LATE_EVENING_IN_CHICAGO,
        // A model guessing UTC is exactly how the wrong day got stored.
        timeZone: "UTC"
      },
      localTimezone: "America/Chicago",
      preferences: { aiEstimates: false }
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(result.meal.localDate).toBe("2026-08-18");
  });

  it("still honours a model-supplied zone when the host has no answer", async () => {
    const store = fakeStore();
    const ctx = baseCtx({
      input: {
        description: "late dinner",
        idempotencyKey: "idem-tz-3",
        consumedAt: LATE_EVENING_IN_CHICAGO,
        timeZone: "America/Chicago"
      },
      preferences: { aiEstimates: false }
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(result.meal.localDate).toBe("2026-08-18");
  });

  it("logs the meal rather than failing when nobody knows the zone", async () => {
    const store = fakeStore();
    const ctx = baseCtx({
      input: {
        description: "late dinner",
        idempotencyKey: "idem-tz-4",
        consumedAt: LATE_EVENING_IN_CHICAGO
      },
      preferences: { aiEstimates: false }
    });
    const result = await createMealsLogHandler(store)(ctx);
    // UTC is a last resort, not a preference. Refusing to log because the user never opened
    // their locale settings would be a worse failure than a few hours of drift.
    expect(result.meal.localDate).toBe("2026-08-19");
  });
});

describe("food.meals.log/correct — strict consumedAt parsing (#1869)", () => {
  it("stores an offset-less local time as one exact instant and derived fields", async () => {
    const store = fakeStore();
    const result = await createMealsLogHandler(store)(
      baseCtx({
        input: {
          description: "late dinner",
          idempotencyKey: "idem-1869-local",
          consumedAt: "2026-08-22T20:14:00"
        },
        localTimezone: "America/Los_Angeles",
        preferences: { aiEstimates: false }
      })
    );

    expect(result.meal.consumedAt).toBe("2026-08-23T03:14:00.000Z");
    expect(result.meal.localDate).toBe("2026-08-22");
    expect(result.meal.timezoneOffset).toBe(-420);
  });

  it("rejects bad consumedAt before creating a row", async () => {
    const store = fakeStore();
    await expect(
      createMealsLogHandler(store)(
        baseCtx({
          input: {
            description: "late dinner",
            idempotencyKey: "idem-1869-gap",
            consumedAt: "2026-03-08T02:30:00"
          },
          localTimezone: "America/Los_Angeles",
          preferences: { aiEstimates: false }
        })
      )
    ).rejects.toBeInstanceOf(InputError);
    expect(store.meals.size).toBe(0);
  });

  it("uses the same parser for correct and leaves time fields alone for description-only edits", async () => {
    const store = fakeStore();
    const original = await store.createMeal({
      mealId: "meal-1869",
      consumedAt: new Date("2026-08-22T18:00:00.000Z"),
      localDate: "2026-08-22",
      timezoneOffset: -420,
      description: "dinner",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1869-original"
    });
    const handler = createMealsCorrectHandler(store);

    const corrected = await handler(
      baseCtx({
        input: {
          mealId: original.mealId,
          expectedRevision: original.estimateRevision,
          consumedAt: "2026-08-22T20:14:00",
          timeZone: "America/Los_Angeles"
        }
      })
    );
    expect(corrected.consumedAt).toBe("2026-08-23T03:14:00.000Z");
    expect(corrected.localDate).toBe("2026-08-22");
    expect(corrected.timezoneOffset).toBe(-420);

    const fixedOffsetOriginal = await store.createMeal({
      mealId: "meal-1869-fixed-offset",
      consumedAt: new Date("2026-08-22T18:00:00.000Z"),
      localDate: "2026-08-22",
      timezoneOffset: -420,
      description: "another dinner",
      servingNote: null,
      captureKind: "text",
      idempotencyKey: "idem-1869-fixed-offset"
    });
    const fixedOffsetCorrected = await handler(
      baseCtx({
        input: {
          mealId: fixedOffsetOriginal.mealId,
          expectedRevision: fixedOffsetOriginal.estimateRevision,
          consumedAt: "2026-08-22T20:14:00"
        }
      })
    );
    expect(fixedOffsetCorrected.consumedAt).toBe("2026-08-23T03:14:00.000Z");
    expect(fixedOffsetCorrected.localDate).toBe("2026-08-22");
    expect(fixedOffsetCorrected.timezoneOffset).toBe(-420);

    const described = await handler(
      baseCtx({
        input: {
          mealId: original.mealId,
          expectedRevision: corrected.estimateRevision,
          description: "updated dinner"
        }
      })
    );
    expect(described.description).toBe("updated dinner");
    expect(described.consumedAt).toBe(corrected.consumedAt);
    expect(described.localDate).toBe(corrected.localDate);
    expect(described.timezoneOffset).toBe(corrected.timezoneOffset);
  });
});
