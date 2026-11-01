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
  LogEntryView,
  LogListResult,
  LogSummaryResult,
  NutrientsView,
  CalorieFit,
  EaterView,
  KitchenView,
  ListLineView,
  MemberView,
  PlannedMealView,
  PlanView,
  RecipeView,
  PantryView,
  ShoppingListView,
  UndoToken
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

const NUTRIENTS: NutrientsView = {
  caloriesKcal: 520,
  proteinG: 30,
  carbohydratesG: 40,
  fatG: 22,
  fiberG: 5,
  sugarG: 6,
  sodiumMg: 800
};
const LOG_ENTRY: LogEntryView = {
  entryId: "e",
  consumedAt: "2026-11-02T18:00:00.000Z",
  localDate: "2026-11-02",
  timezoneOffset: -300,
  description: "chicken salad",
  servingNote: "large bowl",
  captureKind: "text",
  estimateState: "estimated",
  estimateRevision: 2,
  nutrients: NUTRIENTS,
  items: [{ label: "chicken", portionNote: "150 g", nutrients: NUTRIENTS }],
  missingDetails: null,
  clarificationQuestion: null
};
const LOG_LIST: LogListResult = {
  entries: [LOG_ENTRY],
  totals: {
    localDate: "2026-11-02",
    nutrients: NUTRIENTS,
    incomplete: false,
    entriesWithoutEstimate: 0
  },
  targets: { caloriesKcal: 2000, proteinG: 120, carbG: 200, fatG: 70 },
  calorieFit: { targetKcal: 2000, estimatedKcal: 520, band: "under", differenceKcal: -1480 },
  truncated: false,
  totalCount: 1
};
const LOG_SUMMARY: LogSummaryResult = {
  fromLocalDate: "2026-11-01",
  toLocalDate: "2026-11-02",
  nutrients: NUTRIENTS,
  incomplete: false,
  entriesWithoutEstimate: 0,
  daysWithEntries: 2
};

const LINE: Required<ListLineView> = {
  lineId: "l",
  name: "milk",
  quantity: 500,
  unit: "ml",
  purchase: { quantity: 1, unit: "l" },
  section: "dairy_eggs",
  manual: false,
  coveredByPantry: false,
  notInPlan: false,
  convertedFrom: ["1 cup"],
  sources: [{ mealId: "meal", label: "Mon dinner" }],
  checkedAt: "2026-11-02T18:00:00Z",
  boughtAt: "2026-11-02T19:00:00Z"
};
const LIST: Required<ShoppingListView> = {
  listId: "x",
  planId: "p",
  pantryMode: "prefer",
  lines: [LINE]
};
const UNDO: Required<UndoToken> = { actionId: "a", kind: "bought", count: 2 };
const PANTRY: Required<PantryView> = {
  items: [
    {
      itemId: "i",
      name: "Rice",
      quantity: 500,
      unit: "g",
      source: "manual",
      updatedAt: "2026-11-02T10:00:00Z"
    }
  ],
  staples: [{ stapleId: "s", name: "Salt" }]
};

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

  it("declares the S1 to S6 tools with their risks and handlers", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    expect(tools.map((entry) => [entry.name, entry.risk, entry.handler])).toEqual([
      ["meals.kitchen.get", "read", "kitchen.get"],
      ["meals.kitchen.save", "write", "kitchen.save"],
      ["meals.household.save", "write", "household.save"],
      ["meals.household.remove", "destructive", "household.remove"],
      ["meals.plan.create", "write", "plan.create"],
      ["meals.plan.get", "read", "plan.get"],
      ["meals.plan.current", "read", "plan.current"],
      ["meals.plan.control", "write", "plan.control"],
      ["meals.plan.delete", "destructive", "plan.delete"],
      ["meals.meal.get", "read", "meal.get"],
      ["meals.list.get", "read", "list.get"],
      ["meals.list.build", "write", "list.build"],
      ["meals.list.edit", "write", "list.edit"],
      ["meals.list.bought", "write", "list.bought"],
      ["meals.list.clear", "destructive", "list.clear"],
      ["meals.pantry.get", "read", "pantry.get"],
      ["meals.pantry.edit", "write", "pantry.edit"],
      ["meals.undo", "write", "undo"],
      ["meals.log.list", "read", "log.list"],
      ["meals.log.summarize", "read", "log.summarize"],
      ["meals.log.add", "write", "log.add"],
      ["meals.log.reestimate", "write", "log.reestimate"],
      ["meals.log.correct", "write", "log.correct"],
      ["meals.log.delete", "destructive", "log.delete"]
    ]);
    expect(tool("meals.log.delete").selfOperationGrant).toBe("confirm_always");
    expect(tool("meals.log.add").selfOperationGrant).toBe("granted_at_install");
    expect(tool("meals.log.correct").actionFamilyId).toBe("meal_logging");
    expect(tool("meals.list.clear").selfOperationGrant).toBe("confirm_always");
    expect(tool("meals.list.bought").selfOperationGrant).toBe("granted_at_install");
    expect(tool("meals.household.remove").selfOperationGrant).toBe("confirm_always");
    expect(tool("meals.plan.delete").selfOperationGrant).toBe("confirm_always");
  });

  it("requires in each input schema what the handler requires, at the handler's limits", () => {
    const save = tool("meals.kitchen.save").inputSchema as Schema;
    expect(save.properties!.slotRules!.items!.required).toEqual(["slotName", "soloWeekdays"]);

    const member = tool("meals.household.save").inputSchema as Schema & {
      properties: Record<"restrictions" | "preferences", { items: { maxLength: number } }>;
    };
    expect(member.properties.restrictions.items.maxLength).toBe(80);
    expect(member.properties.preferences.items.maxLength).toBe(120);
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

  it("declares the day and estimate queues with ids-only params", () => {
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
      },
      {
        name: "meals.log-estimate",
        handler: "log.estimate",
        retryLimit: 2,
        allowModuleEnqueue: true,
        paramsSchema: {
          type: "object",
          fields: {
            entryId: { type: "uuid" },
            revision: { type: "integer", min: 1, max: 1000000 }
          }
        }
      }
    ]);
  });

  it("owns exactly the S1 to S6 tables", () => {
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
        "app.meals_planned_meal_eaters",
        "app.meals_shopping_lists",
        "app.meals_shopping_list_items",
        "app.meals_pantry_items",
        "app.meals_undo_actions",
        "app.meals_staples",
        "app.meals_log_entries",
        "app.meals_log_estimates",
        "app.meals_log_estimate_items"
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
    ["meals.plan.current", { plan: PLAN }],
    ["meals.plan.control", PLAN],
    ["meals.plan.delete", { deleted: true }],
    ["meals.meal.get", RECIPE],
    ["meals.list.get", LIST],
    ["meals.list.build", LIST],
    ["meals.list.edit", { list: LIST, undo: UNDO }],
    ["meals.list.bought", { list: LIST, pantryAdded: 2, undo: UNDO }],
    ["meals.list.clear", { cleared: true }],
    ["meals.pantry.get", PANTRY],
    ["meals.pantry.edit", { pantry: PANTRY, undo: UNDO }],
    ["meals.undo", { restored: 1, skipped: 0 }],
    ["meals.log.list", LOG_LIST],
    ["meals.log.summarize", LOG_SUMMARY],
    ["meals.log.add", { entry: LOG_ENTRY }],
    ["meals.log.reestimate", { entry: LOG_ENTRY }],
    ["meals.log.correct", { entry: LOG_ENTRY }],
    ["meals.log.delete", { entryId: "e", deleted: true }]
  ])("%s output schema covers every view field", (name, sample) => {
    expect(uncovered(tool(name).outputSchema as Schema, sample)).toEqual([]);
  });

  it("gives every tool a plain-English action label, never the tool name", () => {
    const tools = loadManifest().assistantTools as Array<{ name: string; actionLabel?: string }>;
    for (const entry of tools) {
      expect(entry.actionLabel, entry.name).toBeTruthy();
      expect(entry.actionLabel, entry.name).not.toMatch(/[a-z]\.[a-z]/);
    }
  });

  it("lets plan.create name which meals to plan", () => {
    const create = tool("meals.plan.create");
    const props = (create.inputSchema as Schema).properties as Record<string, { type: string }>;
    expect(props["mealTypes"]?.type).toBe("array");
    expect(create.description).toContain("mealTypes");
  });

  it("maps the Household and Settings screens and the chat feature", () => {
    const appMap = loadManifest().appMap as {
      screens: Array<{ id: string; path: string }>;
      features: Array<{ id: string }>;
    };
    expect(appMap.screens.map((screen) => [screen.id, screen.path])).toEqual(
      expect.arrayContaining([
        ["meals.list", "/list"],
        ["meals.log", "/log"],
        ["meals.recipe", "/recipe"],
        ["meals.household", "/household"],
        ["meals.settings", "/settings"]
      ])
    );
    expect(appMap.features.map((feature) => feature.id)).toContain("meals.chat-household");
    expect(appMap.features.map((feature) => feature.id)).toContain("meals.chat-list");
    expect(appMap.features.map((feature) => feature.id)).toContain("meals.chat-log");
  });

  it("maps plan writing and Safety in the words the plan gives", () => {
    const features = (loadManifest().appMap as { features: Array<Record<string, unknown>> })
      .features;
    const description = (id: string) => features.find((feature) => feature.id === id)?.description;
    expect(description("meals.chat-plan")).toBe(
      "Ask Moss to plan any number of days up to 28. Days are written one by one. Stop, resume, or retry one day."
    );
    expect(description("meals.safety")).toBe(
      "Every meal is checked against each eater's Never serve list. The check only says nothing listed was found outright, never that a meal is safe, and every result, pass or fail, reminds you to double check. Packaged or branded ingredients carry a check-the-label note."
    );
  });
});
