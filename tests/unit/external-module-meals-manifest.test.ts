// tests/unit/external-module-meals-manifest.test.ts
//
// Meals S1 (#3885): the shipped manifest passes the external ABI, every handler it names is
// registered, and every output schema covers every field of its view. The host trims a tool
// result to its declared output schema, so a view field missing from the schema reaches the
// page blank.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateExternalModuleManifest } from "@moss/module-registry";

import type { KitchenView, MemberView } from "../../external-modules/meals/src/contracts.js";
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

  it("declares the four S1 tools with their risks and handlers", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    expect(tools.map((entry) => [entry.name, entry.risk, entry.handler])).toEqual([
      ["meals.kitchen.get", "read", "kitchen.get"],
      ["meals.kitchen.save", "write", "kitchen.save"],
      ["meals.household.save", "write", "household.save"],
      ["meals.household.remove", "destructive", "household.remove"]
    ]);
    expect(tool("meals.household.remove").selfOperationGrant).toBe("confirm_always");
  });

  it("requires in each input schema what the handler requires, at the handler's limits", () => {
    const save = tool("meals.kitchen.save").inputSchema as Schema;
    expect(save.properties!.slotRules!.items!.required).toEqual(["slotName", "soloWeekdays"]);

    const member = tool("meals.household.save").inputSchema as Schema & {
      properties: Record<string, { items: { maxLength: number } }>;
    };
    expect(member.properties.restrictions.items.maxLength).toBe(80);
    expect(member.properties.preferences.items.maxLength).toBe(120);
  });

  it("registers every manifest handler and nothing more", () => {
    const tools = loadManifest().assistantTools as Array<Record<string, unknown>>;
    expect(Object.keys(HANDLERS).sort()).toEqual(
      tools.map((entry) => entry.handler as string).sort()
    );
  });

  it("owns exactly the three S1 tables", () => {
    expect(loadManifest().database).toEqual({
      ownedTables: [
        "app.meals_kitchens",
        "app.meals_household_members",
        "app.meals_meal_slot_rules"
      ]
    });
  });

  it.each([
    ["meals.kitchen.get", KITCHEN],
    ["meals.kitchen.save", KITCHEN],
    ["meals.household.save", MEMBER],
    ["meals.household.remove", { removed: true }]
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
});
