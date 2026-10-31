// tests/integration/meals-tables-install.test.ts
//
// Meals S1 (#3885): the real external-modules/meals/sql installs through the module pipeline
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
  "app.meals_meal_slot_rules"
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
  it("installs four migrations with FORCE RLS on every table, and re-runs as a no-op", async () => {
    expect(installedCount).toBe(4);
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
