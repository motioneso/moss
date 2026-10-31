// external-modules/meals/src/store/sql.ts
//
// The Kitchen, its household members and its slot rules. Every query runs under the module
// runtime role with RLS scoped to the acting owner, so no query names an owner except through
// app.current_actor_user_id() on insert.
//
// ctx.db allows SELECT, INSERT, UPDATE and DELETE only, with no transactions. First-use creation
// is therefore INSERT ... ON CONFLICT DO NOTHING against the unique keys, which keeps two racing
// first reads to one Kitchen and one self member.
import type {
  KitchenView,
  MemberView,
  PantryMode,
  SlotRuleView,
  UnitsSystem
} from "../contracts.js";

/** Structural twin of ModuleWorkerContext.db. */
export interface MealsDb {
  query<T = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface KitchenPatch {
  readonly unitsSystem?: UnitsSystem;
  readonly defaultPantryMode?: PantryMode;
}

/** Member fields to write. Undefined keeps the stored value; null clears a nullable one. */
export interface MemberFields {
  readonly name?: string;
  readonly linkedAccountEmail?: string | null;
  readonly calorieTarget?: number | null;
  readonly proteinTargetG?: number | null;
  readonly carbTargetG?: number | null;
  readonly fatTargetG?: number | null;
  readonly mealPattern?: readonly string[];
  readonly restrictions?: readonly string[];
  readonly preferences?: readonly string[];
}

export interface MealsStore {
  /** Returns the owner's Kitchen, creating it and a self member named "You" on first use. */
  getOrCreateKitchen(): Promise<KitchenView>;
  updateKitchen(kitchenId: string, patch: KitchenPatch): Promise<void>;
  /** One row per slot name. A rule for an existing slot replaces it. */
  upsertSlotRules(kitchenId: string, rules: readonly SlotRuleView[]): Promise<void>;
  addMember(
    kitchenId: string,
    fields: MemberFields & { readonly name: string }
  ): Promise<MemberView>;
  /** Null when no member with this id is visible to the owner. */
  updateMember(memberId: string, fields: MemberFields): Promise<MemberView | null>;
  /** False when the member is missing or is the self member, whose row is never deleted. */
  removeMember(memberId: string): Promise<boolean>;
}

interface KitchenRow {
  kitchen_id: string;
  units_system: UnitsSystem;
  default_pantry_mode: PantryMode;
}

interface MemberRow {
  member_id: string;
  name: string;
  is_self: boolean;
  linked_account_email: string | null;
  calorie_target: number | null;
  protein_target_g: number | null;
  carb_target_g: number | null;
  fat_target_g: number | null;
  meal_pattern: string[];
  restrictions: string[];
  preferences: string[];
}

interface SlotRuleRow {
  slot_name: string;
  solo_weekdays: number[];
  usual_time: string | null;
}

const MEMBER_COLUMNS =
  "member_id, name, is_self, linked_account_email, calorie_target, protein_target_g, " +
  "carb_target_g, fat_target_g, meal_pattern, restrictions, preferences";

const SELF_NAME = "You";

function toMember(row: MemberRow): MemberView {
  return {
    memberId: row.member_id,
    name: row.name,
    isSelf: row.is_self,
    linkedAccountEmail: row.linked_account_email,
    calorieTarget: row.calorie_target,
    macroTargets: {
      proteinG: row.protein_target_g,
      carbG: row.carb_target_g,
      fatG: row.fat_target_g
    },
    mealPattern: row.meal_pattern,
    restrictions: row.restrictions,
    preferences: row.preferences,
    // Favourites arrive with recipes in S10.
    favouriteRecipeIds: []
  };
}

/** Column, cast and value for each member field present in `fields`. */
function memberAssignments(fields: MemberFields): Array<[string, string, unknown]> {
  const out: Array<[string, string, unknown]> = [];
  const add = (column: string, cast: string, value: unknown) => {
    if (value !== undefined) out.push([column, cast, value]);
  };
  add("name", "text", fields.name);
  add("linked_account_email", "text", fields.linkedAccountEmail);
  add("calorie_target", "integer", fields.calorieTarget);
  add("protein_target_g", "integer", fields.proteinTargetG);
  add("carb_target_g", "integer", fields.carbTargetG);
  add("fat_target_g", "integer", fields.fatTargetG);
  const json = (value: readonly string[] | undefined) =>
    value === undefined ? undefined : JSON.stringify(value);
  add("meal_pattern", "jsonb", json(fields.mealPattern));
  add("restrictions", "jsonb", json(fields.restrictions));
  add("preferences", "jsonb", json(fields.preferences));
  return out;
}

export function sqlStore(db: MealsDb): MealsStore {
  async function readKitchen(): Promise<KitchenRow | null> {
    const { rows } = await db.query<KitchenRow>(
      "SELECT kitchen_id, units_system, default_pantry_mode FROM app.meals_kitchens"
    );
    return rows[0] ?? null;
  }

  async function readMembers(kitchenId: string): Promise<MemberRow[]> {
    const { rows } = await db.query<MemberRow>(
      `SELECT ${MEMBER_COLUMNS} FROM app.meals_household_members WHERE kitchen_id = $1 ` +
        "ORDER BY is_self DESC, sort_order, created_at, member_id",
      [kitchenId]
    );
    return rows;
  }

  return {
    async getOrCreateKitchen() {
      let kitchen = await readKitchen();
      if (kitchen === null) {
        await db.query(
          "INSERT INTO app.meals_kitchens (owner_user_id, kitchen_id) " +
            "VALUES (app.current_actor_user_id(), gen_random_uuid()) " +
            "ON CONFLICT (owner_user_id) DO NOTHING"
        );
        kitchen = await readKitchen();
        if (kitchen === null) throw new Error("kitchen not visible after insert");
      }

      let members = await readMembers(kitchen.kitchen_id);
      if (!members.some((member) => member.is_self)) {
        await db.query(
          "INSERT INTO app.meals_household_members " +
            "(owner_user_id, kitchen_id, member_id, name, is_self) " +
            "VALUES (app.current_actor_user_id(), $1, gen_random_uuid(), $2, true) " +
            "ON CONFLICT (owner_user_id, kitchen_id) WHERE is_self DO NOTHING",
          [kitchen.kitchen_id, SELF_NAME]
        );
        members = await readMembers(kitchen.kitchen_id);
      }

      const { rows: rules } = await db.query<SlotRuleRow>(
        "SELECT slot_name, solo_weekdays::int[] AS solo_weekdays, " +
          "to_char(usual_time, 'HH24:MI') AS usual_time " +
          "FROM app.meals_meal_slot_rules WHERE kitchen_id = $1 ORDER BY created_at, slot_name",
        [kitchen.kitchen_id]
      );

      return {
        kitchenId: kitchen.kitchen_id,
        unitsSystem: kitchen.units_system,
        defaultPantryMode: kitchen.default_pantry_mode,
        members: members.map(toMember),
        slotRules: rules.map((rule) => ({
          slotName: rule.slot_name,
          soloWeekdays: rule.solo_weekdays,
          usualTime: rule.usual_time
        }))
      };
    },

    async updateKitchen(kitchenId, patch) {
      await db.query(
        "UPDATE app.meals_kitchens SET " +
          "units_system = coalesce($2, units_system), " +
          "default_pantry_mode = coalesce($3, default_pantry_mode), updated_at = now() " +
          "WHERE kitchen_id = $1",
        [kitchenId, patch.unitsSystem ?? null, patch.defaultPantryMode ?? null]
      );
    },

    async upsertSlotRules(kitchenId, rules) {
      for (const rule of rules) {
        await db.query(
          "INSERT INTO app.meals_meal_slot_rules " +
            "(owner_user_id, kitchen_id, slot_name, solo_weekdays, usual_time) " +
            "VALUES (app.current_actor_user_id(), $1, $2, $3::smallint[], $4::time) " +
            "ON CONFLICT (owner_user_id, kitchen_id, slot_name) DO UPDATE SET " +
            "solo_weekdays = EXCLUDED.solo_weekdays, usual_time = EXCLUDED.usual_time, " +
            "updated_at = now()",
          [kitchenId, rule.slotName, [...rule.soloWeekdays], rule.usualTime]
        );
      }
    },

    async addMember(kitchenId, fields) {
      const assignments = memberAssignments(fields);
      const columns = assignments.map(([column]) => column);
      const values = assignments.map(([, cast], index) => `$${index + 2}::${cast}`);
      const { rows } = await db.query<MemberRow>(
        "INSERT INTO app.meals_household_members " +
          `(owner_user_id, kitchen_id, member_id, sort_order, ${columns.join(", ")}) ` +
          "VALUES (app.current_actor_user_id(), $1, gen_random_uuid(), " +
          "(SELECT coalesce(max(sort_order), 0) + 1 FROM app.meals_household_members " +
          `WHERE kitchen_id = $1), ${values.join(", ")}) RETURNING ${MEMBER_COLUMNS}`,
        [kitchenId, ...assignments.map(([, , value]) => value)]
      );
      return toMember(rows[0]!);
    },

    async updateMember(memberId, fields) {
      const assignments = memberAssignments(fields);
      const sets = assignments.map(([column, cast], index) => `${column} = $${index + 2}::${cast}`);
      const { rows } = await db.query<MemberRow>(
        `UPDATE app.meals_household_members SET ${[...sets, "updated_at = now()"].join(", ")} ` +
          `WHERE member_id = $1 RETURNING ${MEMBER_COLUMNS}`,
        [memberId, ...assignments.map(([, , value]) => value)]
      );
      return rows[0] ? toMember(rows[0]) : null;
    },

    async removeMember(memberId) {
      const { rows } = await db.query(
        "DELETE FROM app.meals_household_members WHERE member_id = $1 AND NOT is_self " +
          "RETURNING member_id",
        [memberId]
      );
      return rows.length > 0;
    }
  };
}
