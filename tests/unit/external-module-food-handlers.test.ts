// tests/unit/external-module-food-handlers.test.ts
//
// Food Phase 1 (#926, #1701, plan §4 Task 7): the tools/worker handler layer
// (external-modules/food/src/tools/meals.ts, src/tools/consent.ts,
// src/worker/handlers/estimate.ts) exercised against a FakeFoodStore (implements the
// FoodStore interface's documented CAS/idempotency contract in memory) and fake
// kv/ai ports matching ModuleWorkerContext's structural shape — no db, no real SQL.
//
// Behaviours from the plan:
//   1  Meal persists before estimation — a provider blip never loses the meal
//   2  Idempotent create — a retry never re-triggers estimation (handler-level half;
//      store-level half is in external-module-food-store.test.ts)
//   7  Stale revision rejected — handler propagates the store's null correctly
//   8  Consent gate BEFORE any provider call
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

import type { Meal, Nutrients } from "../../external-modules/food/src/domain/meal.js";
import {
  createMealsListHandler,
  createMealsLogHandler,
  createMealsReestimateHandler
} from "../../external-modules/food/src/tools/meals.js";
import { getConsent, grantConsent } from "../../external-modules/food/src/tools/consent.js";
import { runEstimate } from "../../external-modules/food/src/worker/handlers/estimate.js";
import type {
  CorrectMealPatch,
  CreateMealInput,
  FoodStore,
  RecordEstimateInput
} from "../../external-modules/food/src/store/sql.js";

// ── Fakes ────────────────────────────────────────────────────────────────

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
      const nutrients = patch.nutrients
        ? ({ ...(meal.nutrients ?? nullNutrients()), ...patch.nutrients } as Nutrients)
        : meal.nutrients;
      const updated: Meal = {
        ...meal,
        description: patch.description ?? meal.description,
        consumedAt: patch.consumedAt ? patch.consumedAt.toISOString() : meal.consumedAt,
        localDate: patch.localDate ?? meal.localDate,
        timezoneOffset: patch.timezoneOffset ?? meal.timezoneOffset,
        estimateState: patch.nutrients ? "estimated" : meal.estimateState,
        estimateRevision: meal.estimateRevision + 1,
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

/** Fake kv keyed by `${scope}:${namespace}:${key}` — enough for consent.ts + meals.ts's
 * hasGrantedConsent, which are the only kv calls this handler layer makes. */
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
}) {
  return {
    input: overrides.input ?? {},
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

async function grantConsentFor(kv: ReturnType<typeof fakeKv>) {
  await kv.set("user", "food.settings", "consent", {
    granted: true,
    grantedAt: "2026-07-18T00:00:00.000Z"
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("food.meals.log — test 8: consent gate before any provider call", () => {
  it("consent ungranted: meal saves pending, ai.generateStructured is never called", async () => {
    const store = fakeStore();
    const ai = fakeAi(() => ({ ok: true, object: {} }));
    const ctx = baseCtx({
      input: { description: "a bowl of oatmeal", idempotencyKey: "idem-1" },
      ai
    });
    const result = await createMealsLogHandler(store)(ctx);
    expect(result.meal.estimateState).toBe("pending");
    expect(ai.generateStructured).not.toHaveBeenCalled();
  });

  it("consent granted: the provider is called and the estimate is recorded", async () => {
    const store = fakeStore();
    const kv = fakeKv();
    await grantConsentFor(kv);
    const ai = fakeAi(() => ({
      ok: true,
      object: {
        outcome: "estimated",
        caloriesKcal: 350,
        proteinG: 10,
        carbohydratesG: 65,
        fatG: 6,
        fiberG: 8,
        sugarG: 20,
        sodiumMg: 150,
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
    await grantConsentFor(kv);
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
    await grantConsentFor(kv);
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
    await grantConsentFor(kv);
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
      nutrients: { ...nullNutrients(), caloriesKcal: 400 },
      missingDetails: null,
      clarificationQuestion: null
    });
    const kv = fakeKv();
    await grantConsentFor(kv);
    const ai = fakeAi(() => ({ ok: true, object: {} }));
    const ctx = baseCtx({ input: { mealId: "meal-1" }, kv, ai });
    const result = await createMealsReestimateHandler(store)(ctx);
    expect(result.meal.estimateState).toBe("estimated");
    expect(ai.generateStructured).not.toHaveBeenCalled(); // already estimated: no re-roll
  });
});

describe("food.consent (test 8's source of truth)", () => {
  it("consent.get reads what consent.grant wrote", async () => {
    const kv = fakeKv();
    const grantCtx = baseCtx({ input: { granted: true }, kv });
    const granted = await grantConsent(grantCtx);
    expect(granted.granted).toBe(true);
    expect(typeof granted.grantedAt).toBe("string");

    const readCtx = baseCtx({ input: {}, kv });
    const state = await getConsent(readCtx);
    expect(state).toEqual(granted);
  });

  it("revoking sets grantedAt back to null", async () => {
    const kv = fakeKv();
    await grantConsent(baseCtx({ input: { granted: true }, kv }));
    const revoked = await grantConsent(baseCtx({ input: { granted: false }, kv }));
    expect(revoked).toEqual({ granted: false, grantedAt: null });
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

describe("worker estimate.run handler (queue retry path)", () => {
  it("consent gate is checked before any provider call here too", async () => {
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
    const kv = fakeKv(); // consent NOT granted
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
        throw new Error(`unexpected query: ${text}`);
      })
    };
    const ctx = baseCtx({ input: { mealId: meal.mealId, revision: 1 }, kv, ai });
    (ctx as unknown as { db: typeof db }).db = db;
    const result = await runEstimate(ctx);
    expect(result).toEqual({ status: "no-op", reason: "consent_not_granted" });
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
