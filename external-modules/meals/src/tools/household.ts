// external-modules/meals/src/tools/household.ts
//
// The four S1 tools. kitchen.get is a read tool and never writes; the write tools store the
// Kitchen on first use, so planning for yourself needs no setup. Self targets live on the self member row
// and no handler reads a preference store (spec correction C3).
import type { ModuleWorkerContext } from "@moss/module-sdk/worker";

import type {
  KitchenView,
  MemberView,
  PantryMode,
  SlotRuleView,
  UnitsSystem
} from "../contracts.js";
import type { MealsStore, MemberFields } from "../store/sql.js";
import {
  InputError,
  readEnum,
  readNullableInt,
  readText,
  readTextList,
  readUuid,
  requireNoUnknownKeys,
  stripEnvelope
} from "./validate.js";

const UNITS: readonly UnitsSystem[] = ["us", "metric"];
const PANTRY_MODES: readonly PantryMode[] = ["ignore", "prefer", "only"];
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_SLOT_RULES = 6;

const KITCHEN_GET_KEYS = new Set<string>();
const KITCHEN_SAVE_KEYS = new Set(["unitsSystem", "defaultPantryMode", "slotRules"]);
const SLOT_RULE_KEYS = new Set(["slotName", "soloWeekdays", "usualTime"]);
const HOUSEHOLD_SAVE_KEYS = new Set([
  "memberId",
  "name",
  "linkedAccountEmail",
  "calorieTarget",
  "proteinTargetG",
  "carbTargetG",
  "fatTargetG",
  "mealPattern",
  "restrictions",
  "preferences"
]);
const HOUSEHOLD_REMOVE_KEYS = new Set(["memberId"]);

export function createKitchenGetHandler(store: MealsStore) {
  return async (ctx: ModuleWorkerContext): Promise<KitchenView> => {
    requireNoUnknownKeys(stripEnvelope(ctx.input), KITCHEN_GET_KEYS);
    return store.readKitchen();
  };
}

export function createKitchenSaveHandler(store: MealsStore) {
  return async (ctx: ModuleWorkerContext): Promise<KitchenView> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, KITCHEN_SAVE_KEYS);
    const unitsSystem = readEnum(input, "unitsSystem", UNITS);
    const defaultPantryMode = readEnum(input, "defaultPantryMode", PANTRY_MODES);
    const slotRules = readSlotRules(input.slotRules);

    const { kitchenId } = await store.getOrCreateKitchen();
    if (unitsSystem !== undefined || defaultPantryMode !== undefined) {
      await store.updateKitchen(kitchenId, { unitsSystem, defaultPantryMode });
    }
    if (slotRules.length > 0) {
      await store.upsertSlotRules(kitchenId, slotRules);
    }
    return store.getOrCreateKitchen();
  };
}

export function createHouseholdSaveHandler(store: MealsStore) {
  return async (ctx: ModuleWorkerContext): Promise<MemberView> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, HOUSEHOLD_SAVE_KEYS);
    const memberId = readUuid(input, "memberId");
    const fields = readMemberFields(input, memberId === undefined);

    const { kitchenId } = await store.getOrCreateKitchen();
    if (memberId === undefined) {
      return store.addMember(kitchenId, { ...fields, name: fields.name! });
    }
    const updated = await store.updateMember(memberId, fields);
    if (updated === null) {
      throw new InputError("member_not_found", "memberId names no household member");
    }
    return updated;
  };
}

export function createHouseholdRemoveHandler(store: MealsStore) {
  return async (ctx: ModuleWorkerContext): Promise<{ removed: boolean }> => {
    const input = stripEnvelope(ctx.input);
    requireNoUnknownKeys(input, HOUSEHOLD_REMOVE_KEYS);
    const memberId = readUuid(input, "memberId", { required: true });

    const kitchen = await store.readKitchen();
    if (kitchen.members.some((member) => member.memberId === memberId && member.isSelf)) {
      throw new InputError("self_member", "the self member cannot be removed");
    }
    return { removed: await store.removeMember(memberId) };
  };
}

function readMemberFields(input: Record<string, unknown>, adding: boolean): MemberFields {
  const email = input.linkedAccountEmail;
  let linkedAccountEmail: string | null | undefined;
  if (email === null) {
    linkedAccountEmail = null;
  } else {
    linkedAccountEmail = readText(input, "linkedAccountEmail", { maxChars: 320 });
    if (linkedAccountEmail !== undefined && !EMAIL.test(linkedAccountEmail)) {
      throw new InputError("linkedAccountEmail must be an email address");
    }
  }

  return {
    name: readText(input, "name", { required: adding, maxChars: 80 }),
    linkedAccountEmail,
    calorieTarget: readNullableInt(input, "calorieTarget", { min: 800, max: 6000 }),
    proteinTargetG: readNullableInt(input, "proteinTargetG", { min: 0, max: 600 }),
    carbTargetG: readNullableInt(input, "carbTargetG", { min: 0, max: 1000 }),
    fatTargetG: readNullableInt(input, "fatTargetG", { min: 0, max: 400 }),
    mealPattern: readTextList(input, "mealPattern", {
      minItems: 1,
      maxItems: 6,
      maxChars: 40,
      lowercase: true
    }),
    restrictions: readTextList(input, "restrictions", { minItems: 0, maxItems: 40, maxChars: 80 }),
    preferences: readTextList(input, "preferences", { minItems: 0, maxItems: 40, maxChars: 120 })
  };
}

function readSlotRules(raw: unknown): SlotRuleView[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SLOT_RULES) {
    throw new InputError(`slotRules must be an array of at most ${MAX_SLOT_RULES} rules`);
  }
  return raw.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new InputError("slotRules entries must be objects");
    }
    const rule = entry as Record<string, unknown>;
    requireNoUnknownKeys(rule, SLOT_RULE_KEYS);
    const slotName = readText(rule, "slotName", { required: true, maxChars: 40 })!.toLowerCase();

    const weekdays = rule.soloWeekdays;
    if (
      !Array.isArray(weekdays) ||
      !weekdays.every((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    ) {
      throw new InputError("soloWeekdays must hold ISO weekdays, 1 (Monday) to 7 (Sunday)");
    }
    const soloWeekdays = [...new Set(weekdays as number[])].sort((a, b) => a - b);

    const usualTime = rule.usualTime ?? null;
    if (usualTime !== null && (typeof usualTime !== "string" || !HH_MM.test(usualTime))) {
      throw new InputError("usualTime must be HH:MM or null");
    }
    return { slotName, soloWeekdays, usualTime };
  });
}
