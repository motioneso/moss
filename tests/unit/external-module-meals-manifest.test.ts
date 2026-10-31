// tests/unit/external-module-meals-manifest.test.ts
//
// Meals S1 (#3885) and S2 (#3886): the shipped manifest passes the external ABI, every handler it names is
// registered, and every output schema covers every field of its view. The host trims a tool
// result to its declared output schema, so a view field missing from the schema reaches the
// page blank.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

import type {
  CalorieFit,
  EaterView,
  KitchenView,
  MemberView,
  PlannedMealView,
  PlanView,
  RecipeView
} from "../../external-modules/meals/src/contracts.js";
import { HANDLERS } from "../../external-modules/meals/src/worker/registry.js";

const manifestPath = fileURLToPath(
  new URL("../../external-modules/meals/jarvis.module.json", import.meta.url)
);
const loadManifest = (): Record<string, unknown> =>
  JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;

type Schema = {
  type?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
  required?: string[];
  anyOf?: Schema[];
};

// Full samples. A field added to a view type fails to compile here until the sample gains it,
// and then fails the coverage check until the manifest schema gains it.
const MEMBER: Required<MemberView> = {
  memberId: "m",
  name: "You",
  isSelf: true,
  linkedAccountEmail: "sam@example.com",
  calorieTarget: 2000,
  macroTargets: { proteinG: 1, carbG: 1, fatG: 1 },
  mealPattern: ["breakfast"],
  restrictions: ["peanuts"],
  preferences: ["spicy"],
  favouriteRecipeIds: ["r"]
};
const KITCHEN: Required<KitchenView> = {
  kitchenId: "k",
  unitsSystem: "us",
  defaultPantryMode: "prefer",
  members: [MEMBER],
  slotRules: [{ slotName: "lunch", soloWeekdays: [1], usualTime: "12:00" }]
};

const FIT: Required<CalorieFit> = {
  targetKcal: 600,
  estimatedKcal: 640,
  band: "on",
  differenceKcal: 40
};
const EATER: Required<EaterView> = {
  memberId: "m",
  name: "You",
  portion: 1.5,
  safety: "fail",
  safetyReason: "peanuts",
  fit: FIT
};
const MEAL: Required<PlannedMealView> = {
  mealId: "meal",
  slotName: "dinner",
  kind: "recipe",
  sharing: "shared",
  status: "failed",
  failureReason: "safety_cap",
  locked: false,
  oneOffFor: "m",
  favouriteOf: "m",
  title: "Rice bowl",
  plainText: "Leftovers",
  cookMinutes: 30,
  servings: 2.5,
  eaters: [EATER],
  checkLabelCount: 1,
  cookedAt: "2026-11-02T18:00:00Z"
};
const PLAN: Required<PlanView> = {
  planId: "p",
  startDate: "2026-11-02",
  dayCount: 7,
  pantryMode: "prefer",
  state: "paused",
  pausedReason: "hourly",
  progress: { ready: 1, total: 7 },
  days: [
    {
      dayId: "d",
      date: "2026-11-02",
      status: "ready",
      failureReason: "timeout",
      cookTimeLimitMinutes: 30,
      meals: [MEAL],
      dayFit: [{ memberId: "m", fit: FIT }]
    }
  ]
};
const RECIPE: Required<RecipeView> = {
  meal: MEAL,
  recipeId: "r",
  baseServings: 2,
  servingsOverride: 3,
  steps: ["Cook"],
  ingredients: [
    {
      originalText: "1 cup rice",
      name: "rice",
      quantity: 1,
      unit: "cup",
      display: "1.5 cup",
      section: "pantry",
      checkLabel: true,
      missing: false
    }
  ],
  swapChoices: [{ choiceId: "c", status: "ready", title: "Soup", cookMinutes: 20, eaters: [EATER] }]
};

/** Every key path in `value` that `schema` would drop. */
function uncovered(schema: Schema, value: unknown, path = ""): string[] {
  const branch = schema.anyOf?.find((option) => option.type !== "null") ?? schema;
  if (Array.isArray(value)) {
    if (!branch.items) return [`${path}[] has no items schema`];
    return value.flatMap((item) => uncovered(branch.items!, item, `${path}[]`));
  }
  if (value !== null && typeof value === "object") {
    const properties = branch.properties ?? {};
    return Object.entries(value).flatMap(([key, child]) =>
      key in properties
        ? [
            ...(branch.required?.includes(key) ? [] : [`${path}.${key} not required`]),
            ...uncovered(properties[key]!, child, `${path}.${key}`)
          ]
        : [`${path}.${key}`]
    );
  }
  return [];
}

function tool(name: string): Record<string, unknown> {
  const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
  const found = tools.find((entry) => entry.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe("meals manifest", () => {
  it("passes the external ABI", () => {
    const result = validateExternalModuleManifest(loadManifest(), "meals", "0.1.0");
    expect(result.ok, JSON.stringify(!result.ok ? result.errors : [])).toBe(true);
  });

  it("declares the S1 and S2 tools with their risks and handlers", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    expect(tools.map((entry) => [entry.name, entry.risk, entry.handler])).toEqual([
      ["meals.kitchen.get", "read", "kitchen.get"],
      ["meals.kitchen.save", "write", "kitchen.save"],
      ["meals.household.save", "write", "household.save"],
      ["meals.household.remove", "destructive", "household.remove"],
      ["meals.plan.create", "write", "plan.create"],
      ["meals.plan.get", "read", "plan.get"],
      ["meals.plan.control", "write", "plan.control"],
      ["meals.plan.delete", "destructive", "plan.delete"],
      ["meals.meal.get", "read", "meal.get"]
    ]);
    expect(tool("meals.household.remove").selfOperationGrant).toBe("confirm_always");
    expect(tool("meals.plan.delete").selfOperationGrant).toBe("confirm_always");
  });

  it("requires in each input schema what the handler requires, at the handler's limits", () => {
    const save = tool("meals.kitchen.save").inputSchema as Schema;
    expect(save.properties!.slotRules!.items!.required).toEqual(["slotName", "soloWeekdays"]);

    const member = tool("meals.household.save").inputSchema as Schema & {
      properties: Record<string, { items: { maxLength: number } }>;
    };
    expect(member.properties.restrictions!.items.maxLength).toBe(80);
    expect(member.properties.preferences!.items.maxLength).toBe(120);
  });

  it("registers every manifest handler and nothing more", () => {
    const manifest = loadManifest();
    const tools = manifest.assistantTools as Array<Record<string, unknown>>;
    const queues = (manifest.worker as { queues: Array<{ handler: string }> }).queues;
    expect(Object.keys(HANDLERS).sort()).toEqual(
      [
        ...tools.map((entry) => entry.handler as string),
        ...queues.map((queue) => queue.handler)
      ].sort()
    );
  });

  it("declares the day queue with ids-only params and the ten-minute ceiling", () => {
    const queues = (loadManifest().worker as { queues: Array<Record<string, unknown>> }).queues;
    expect(queues).toEqual([
      {
        name: "meals.plan-day",
        handler: "plan.day",
        retryLimit: 1,
        allowModuleEnqueue: true,
        timeoutMs: 600000,
        paramsSchema: {
          type: "object",
          fields: {
            planId: { type: "uuid" },
            dayId: { type: "uuid" },
            generation: { type: "integer", min: 1, max: 100000 }
          }
        }
      }
    ]);
  });

  it("owns exactly the S1 and S2 tables", () => {
    expect(loadManifest().database).toEqual({
      ownedTables: [
        "app.meals_kitchens",
        "app.meals_household_members",
        "app.meals_meal_slot_rules",
        "app.meals_plans",
        "app.meals_plan_days",
        "app.meals_recipes",
        "app.meals_recipe_ingredients",
        "app.meals_planned_meals",
        "app.meals_planned_meal_eaters"
      ]
    });
  });

  it.each([
    ["meals.kitchen.get", KITCHEN],
    ["meals.kitchen.save", KITCHEN],
    ["meals.household.save", MEMBER],
    ["meals.household.remove", { removed: true }],
    ["meals.plan.create", PLAN],
    ["meals.plan.get", PLAN],
    ["meals.plan.control", PLAN],
    ["meals.plan.delete", { deleted: true }],
    ["meals.meal.get", RECIPE]
  ])("%s output schema covers every view field", (name, sample) => {
    expect(uncovered(tool(name).outputSchema as Schema, sample)).toEqual([]);
  });

  it("maps the Household and Settings screens and the chat feature", () => {
    const appMap = loadManifest().appMap as {
      screens: Array<{ id: string; path: string }>;
      features: Array<{ id: string }>;
    };
    expect(appMap.screens.map((screen) => [screen.id, screen.path])).toEqual(
      expect.arrayContaining([
        ["meals.household", "/household"],
        ["meals.settings", "/settings"]
      ])
    );
    expect(appMap.features.map((feature) => feature.id)).toContain("meals.chat-household");
  });

  it("maps plan writing and Safety in the words the plan gives", () => {
    const features = (loadManifest().appMap as { features: Array<Record<string, unknown>> })
      .features;
    const description = (id: string) => features.find((feature) => feature.id === id)?.description;
    expect(description("meals.chat-plan")).toBe(
      "Ask Moss to plan any number of days up to 28. Days are written one by one. Stop, resume, or retry one day."
    );
    expect(description("meals.safety")).toBe(
      "Every meal is checked against each eater's Never serve list. Packaged or branded ingredients carry a check-the-label note."
    );
  });
});
