// tests/unit/external-module-meals-household.test.ts
//
// Meals S1 (#3885): the four household tools (kitchen.get, kitchen.save, household.save,
// household.remove) run against an in-memory MealsStore that reproduces the SQL store's
// contract. The store-level guarantees (one self row under a race, one slot-rule row per slot,
// owner isolation) are proven against Postgres in tests/integration/meals-tables-install.test.ts.
import { describe, expect, it } from "vitest";

import type { MemberView, SlotRuleView } from "../../external-modules/meals/src/contracts.js";
import type {
  KitchenPatch,
  MealsStore,
  MemberFields
} from "../../external-modules/meals/src/store/sql.js";
import {
  createHouseholdRemoveHandler,
  createHouseholdSaveHandler,
  createKitchenGetHandler,
  createKitchenSaveHandler
} from "../../external-modules/meals/src/tools/household.js";
import { InputError } from "../../external-modules/meals/src/tools/validate.js";
import { HANDLERS } from "../../external-modules/meals/src/worker/registry.js";

// ── Fakes ────────────────────────────────────────────────────────────────

interface FakeState {
  kitchen: {
    kitchenId: string;
    unitsSystem: "us" | "metric";
    defaultPantryMode: "ignore" | "prefer" | "only";
  } | null;
  members: MemberView[];
  slotRules: SlotRuleView[];
}

// Owner-derived ids, as the SQL store derives them: a read before the first write names the rows
// that write stores.
const KITCHEN_ID = "00000000-0000-4000-8000-00000000000a";
const SELF_ID = "00000000-0000-4000-8000-00000000000b";

function fakeStore(): MealsStore & { state: FakeState } {
  const state: FakeState = { kitchen: null, members: [], slotRules: [] };
  let nextId = 1;
  const id = () => `00000000-0000-4000-8000-${String(nextId++).padStart(12, "0")}`;

  function view() {
    const kitchen = state.kitchen!;
    return {
      ...kitchen,
      members: state.members.map((member) => ({ ...member })),
      slotRules: state.slotRules.map((rule) => ({ ...rule }))
    };
  }

  function apply(member: MemberView, fields: MemberFields): MemberView {
    return {
      ...member,
      name: fields.name ?? member.name,
      linkedAccountEmail:
        fields.linkedAccountEmail !== undefined
          ? fields.linkedAccountEmail
          : member.linkedAccountEmail,
      calorieTarget:
        fields.calorieTarget !== undefined ? fields.calorieTarget : member.calorieTarget,
      macroTargets: {
        proteinG:
          fields.proteinTargetG !== undefined
            ? fields.proteinTargetG
            : member.macroTargets.proteinG,
        carbG: fields.carbTargetG !== undefined ? fields.carbTargetG : member.macroTargets.carbG,
        fatG: fields.fatTargetG !== undefined ? fields.fatTargetG : member.macroTargets.fatG
      },
      mealPattern: fields.mealPattern ?? member.mealPattern,
      restrictions: fields.restrictions ?? member.restrictions,
      preferences: fields.preferences ?? member.preferences
    };
  }

  function blank(name: string, isSelf: boolean): MemberView {
    return {
      memberId: id(),
      name,
      isSelf,
      linkedAccountEmail: null,
      calorieTarget: null,
      macroTargets: { proteinG: null, carbG: null, fatG: null },
      mealPattern: ["breakfast", "lunch", "dinner"],
      restrictions: [],
      preferences: [],
      favouriteRecipeIds: []
    };
  }

  return {
    state,
    async readKitchen() {
      if (state.kitchen === null) {
        return {
          kitchenId: KITCHEN_ID,
          unitsSystem: "us",
          defaultPantryMode: "prefer",
          members: [{ ...blank("You", true), memberId: SELF_ID }],
          slotRules: []
        };
      }
      return view();
    },
    async getOrCreateKitchen() {
      if (state.kitchen === null) {
        state.kitchen = { kitchenId: KITCHEN_ID, unitsSystem: "us", defaultPantryMode: "prefer" };
      }
      if (!state.members.some((member) => member.isSelf)) {
        state.members.unshift({ ...blank("You", true), memberId: SELF_ID });
      }
      return view();
    },
    async updateKitchen(kitchenId: string, patch: KitchenPatch) {
      expect(kitchenId).toBe(state.kitchen?.kitchenId);
      state.kitchen = { ...state.kitchen!, ...patch };
    },
    async upsertSlotRules(kitchenId: string, rules: readonly SlotRuleView[]) {
      expect(kitchenId).toBe(state.kitchen?.kitchenId);
      for (const rule of rules) {
        const index = state.slotRules.findIndex((row) => row.slotName === rule.slotName);
        if (index === -1) state.slotRules.push({ ...rule });
        else state.slotRules[index] = { ...rule };
      }
    },
    async addMember(kitchenId: string, fields: MemberFields & { name: string }) {
      expect(kitchenId).toBe(state.kitchen?.kitchenId);
      const member = apply(blank(fields.name, false), fields);
      state.members.push(member);
      return { ...member };
    },
    async updateMember(memberId: string, fields: MemberFields) {
      const index = state.members.findIndex((member) => member.memberId === memberId);
      if (index === -1) return null;
      state.members[index] = apply(state.members[index]!, fields);
      return { ...state.members[index]! };
    },
    async removeMember(memberId: string) {
      const index = state.members.findIndex(
        (member) => member.memberId === memberId && !member.isSelf
      );
      if (index === -1) return false;
      state.members.splice(index, 1);
      return true;
    }
  };
}

/** A context whose preference, kv and ai ports throw on any touch. A household handler that
 * reaches for a preference store (spec correction C3) fails loudly here. */
function ctx(input: Record<string, unknown>) {
  const explode = () => {
    throw new Error("household handlers must not read preferences, kv or ai");
  };
  const trap = new Proxy({}, { get: explode, ownKeys: explode, has: explode });
  return {
    input: { actorUserId: "11111111-1111-4111-8111-111111111111", ...input },
    deadlineAt: Date.now() + 30_000,
    preferences: trap,
    kv: trap,
    ai: trap,
    auth: trap,
    fetch: explode
  } as never;
}

// ── Tests ────────────────────────────────────────────────────────────────

/** A store whose every write throws, as the host's read-tool rule does. */
function readOnlyStore(): MealsStore {
  const store = fakeStore();
  const refuse = async () => {
    throw new Error("forbidden_db_mutation");
  };
  return {
    ...store,
    getOrCreateKitchen: refuse,
    updateKitchen: refuse,
    upsertSlotRules: refuse,
    addMember: refuse,
    updateMember: refuse,
    removeMember: refuse
  };
}

describe("meals.kitchen.get", () => {
  it("never writes, because the host lets a read tool run SELECT only", async () => {
    const kitchen = await createKitchenGetHandler(readOnlyStore())(ctx({}));
    expect(kitchen.members).toEqual([expect.objectContaining({ name: "You", isSelf: true })]);
  });

  it("creates one Kitchen with one self member on first use, and no second on a repeat", async () => {
    const store = fakeStore();
    const get = createKitchenGetHandler(store);

    const first = await get(ctx({}));
    expect(first.members).toHaveLength(1);
    expect(first.members[0]).toMatchObject({
      name: "You",
      isSelf: true,
      mealPattern: ["breakfast", "lunch", "dinner"],
      favouriteRecipeIds: []
    });
    expect(first.unitsSystem).toBe("us");
    expect(first.defaultPantryMode).toBe("prefer");

    const second = await get(ctx({}));
    expect(second.kitchenId).toBe(first.kitchenId);
    expect(second.members.map((member) => member.memberId)).toEqual([first.members[0]!.memberId]);
  });

  it("rejects unknown keys", async () => {
    await expect(createKitchenGetHandler(fakeStore())(ctx({ extra: 1 }))).rejects.toThrow(
      InputError
    );
  });
});

describe("meals.household.save", () => {
  it("adds a member with the breakfast, lunch, dinner pattern by default", async () => {
    const store = fakeStore();
    const sam = await createHouseholdSaveHandler(store)(
      ctx({ name: "Sam", restrictions: ["vegetarian", "peanuts"], calorieTarget: 1800 })
    );
    expect(sam).toMatchObject({
      name: "Sam",
      isSelf: false,
      calorieTarget: 1800,
      mealPattern: ["breakfast", "lunch", "dinner"],
      restrictions: ["vegetarian", "peanuts"],
      preferences: []
    });
    const kitchen = await createKitchenGetHandler(store)(ctx({}));
    expect(kitchen.members.map((member) => member.name)).toEqual(["You", "Sam"]);
  });

  it("edits only the fields given, and null clears a target", async () => {
    const store = fakeStore();
    const save = createHouseholdSaveHandler(store);
    const sam = await save(ctx({ name: "Sam", calorieTarget: 1800, preferences: ["spicy"] }));

    const edited = await save(
      ctx({ memberId: sam.memberId, calorieTarget: null, mealPattern: ["lunch", "dinner"] })
    );
    expect(edited).toMatchObject({
      memberId: sam.memberId,
      name: "Sam",
      calorieTarget: null,
      mealPattern: ["lunch", "dinner"],
      preferences: ["spicy"]
    });
  });

  it("returns self targets from the self member row", async () => {
    const store = fakeStore();
    const kitchen = await createKitchenGetHandler(store)(ctx({}));
    const self = kitchen.members[0]!;

    await createHouseholdSaveHandler(store)(
      ctx({ memberId: self.memberId, calorieTarget: 2200, proteinTargetG: 150 })
    );
    const after = await createKitchenGetHandler(store)(ctx({}));
    expect(after.members[0]).toMatchObject({
      isSelf: true,
      calorieTarget: 2200,
      macroTargets: { proteinG: 150, carbG: null, fatG: null }
    });
  });

  it("requires a name to add, and rejects an unknown member id", async () => {
    const save = createHouseholdSaveHandler(fakeStore());
    await expect(save(ctx({ calorieTarget: 1800 }))).rejects.toThrow(/name is required/);
    await expect(
      save(ctx({ memberId: "99999999-9999-4999-8999-999999999999", name: "Ghost" }))
    ).rejects.toMatchObject({ code: "member_not_found" });
  });

  it("accepts a 120-character preference and rejects 121", async () => {
    const save = createHouseholdSaveHandler(fakeStore());
    const saved = await save(ctx({ name: "Sam", preferences: ["p".repeat(120)] }));
    expect(saved.preferences).toEqual(["p".repeat(120)]);
    await expect(save(ctx({ name: "Sam", preferences: ["p".repeat(121)] }))).rejects.toThrow(
      /preferences/
    );
  });

  it("rejects out-of-range targets and an empty pattern", async () => {
    const save = createHouseholdSaveHandler(fakeStore());
    await expect(save(ctx({ name: "Sam", calorieTarget: 100 }))).rejects.toThrow(
      /calorieTarget must be at least 800/
    );
    await expect(save(ctx({ name: "Sam", mealPattern: [] }))).rejects.toThrow(/mealPattern/);
  });
});

describe("meals.household.remove", () => {
  it("removes a member", async () => {
    const store = fakeStore();
    const sam = await createHouseholdSaveHandler(store)(ctx({ name: "Sam" }));
    await expect(
      createHouseholdRemoveHandler(store)(ctx({ memberId: sam.memberId }))
    ).resolves.toEqual({ removed: true });
    const kitchen = await createKitchenGetHandler(store)(ctx({}));
    expect(kitchen.members.map((member) => member.name)).toEqual(["You"]);
  });

  it("refuses to remove the self member and keeps its row", async () => {
    const store = fakeStore();
    await createHouseholdSaveHandler(store)(ctx({ name: "Sam" }));
    const kitchen = await createKitchenGetHandler(store)(ctx({}));
    const self = kitchen.members[0]!;

    await expect(
      createHouseholdRemoveHandler(store)(ctx({ memberId: self.memberId }))
    ).rejects.toMatchObject({ code: "self_member" });
    expect(store.state.members.filter((member) => member.isSelf)).toHaveLength(1);
  });
});

describe("meals.kitchen.save", () => {
  it("saves units, Pantry mode and a Monday to Friday solo lunch", async () => {
    const store = fakeStore();
    const saved = await createKitchenSaveHandler(store)(
      ctx({
        unitsSystem: "metric",
        defaultPantryMode: "only",
        slotRules: [{ slotName: "lunch", soloWeekdays: [5, 1, 2, 3, 4], usualTime: "12:30" }]
      })
    );
    expect(saved.unitsSystem).toBe("metric");
    expect(saved.defaultPantryMode).toBe("only");
    expect(saved.slotRules).toEqual([
      { slotName: "lunch", soloWeekdays: [1, 2, 3, 4, 5], usualTime: "12:30" }
    ]);
  });

  it("rejects a weekday outside 1 to 7 and a malformed time", async () => {
    const save = createKitchenSaveHandler(fakeStore());
    await expect(
      save(ctx({ slotRules: [{ slotName: "lunch", soloWeekdays: [0], usualTime: null }] }))
    ).rejects.toThrow(/soloWeekdays/);
    await expect(
      save(ctx({ slotRules: [{ slotName: "lunch", soloWeekdays: [], usualTime: "25:00" }] }))
    ).rejects.toThrow(/usualTime/);
  });
});

describe("worker registry", () => {
  it("serves every S1 handler key", () => {
    expect(Object.keys(HANDLERS)).toEqual(
      expect.arrayContaining(["household.remove", "household.save", "kitchen.get", "kitchen.save"])
    );
  });
});
