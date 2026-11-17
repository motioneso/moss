import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { sql, type Kysely } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// The invented Wellness rows used by the Rust test stand-in (rust-spike/standins). Loading them
// through the real database proves the old column rules accept them and that a second person
// cannot read them.
type Row = Record<string, unknown>;
const dir = resolve(import.meta.dirname, "../../rust-spike/standins/fixtures/wellness");
const load = (name: string): { alice: Row[]; bob: Row[] } =>
  JSON.parse(readFileSync(resolve(dir, `${name}.json`), "utf8")) as { alice: Row[]; bob: Row[] };

const people = {
  alice: "aaaaaaaa-0000-4000-8000-000000000001",
  bob: "bbbbbbbb-0000-4000-8000-000000000002"
} as const;
const tables = [
  ["checkins", "app.wellness_checkins"],
  ["medications", "app.medications"],
  ["dose_logs", "app.medication_logs"],
  ["therapy_notes", "app.wellness_therapy_notes"]
] as const;

const snake = (k: string): string => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const ctx = (actorUserId: string): AccessContext => ({
  actorUserId,
  requestId: "req:rust-wellness"
});

let appDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
let admin: pg.Client;

async function insertAs(person: "alice" | "bob"): Promise<void> {
  await runner.withDataContext(ctx(people[person]), async ({ db }) => {
    for (const [file, table] of tables) {
      for (const row of load(file)[person]) {
        const entries = Object.entries(row).filter(([k]) => k !== "ownerUserId");
        const cols = [...entries.map(([k]) => snake(k)), "owner_user_id"];
        const vals = [...entries.map(([, v]) => sql`${v}`), sql`app.current_actor_user_id()`];
        await sql`insert into ${sql.table(table)} (${sql.join(cols.map((c) => sql.id(c)))}) values (${sql.join(vals)})`.execute(
          db
        );
      }
    }
  });
}

async function countsFor(person: "alice" | "bob"): Promise<number[]> {
  return runner.withDataContext(ctx(people[person]), async ({ db }) => {
    const out: number[] = [];
    for (const [, table] of tables) {
      const r = await sql<{
        n: string;
      }>`select count(*)::text as n from ${sql.table(table)}`.execute(db);
      out.push(Number(r.rows[0]?.n));
    }
    return out;
  });
}

const expected = (person: "alice" | "bob"): number[] =>
  tables.map(([file]) => load(file)[person].length);

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  admin = new Client({ connectionString: connectionStrings.bootstrap });
  await admin.connect();
  await admin.query(
    `INSERT INTO app.users (id, email, is_instance_admin)
     VALUES ($1, 'fixture-a@example.test', false), ($2, 'fixture-b@example.test', false)`,
    [people.alice, people.bob]
  );
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(appDb);
  await insertAs("alice");
  await insertAs("bob");
});

afterAll(async () => {
  await appDb?.destroy();
  await admin?.end();
});

describe("invented Wellness rows in the old database", () => {
  it("every row passes the old column rules and each person reads only their own", async () => {
    expect(await countsFor("alice")).toEqual(expected("alice"));
    expect(await countsFor("bob")).toEqual(expected("bob"));
  });

  it("a wide-open read rule lets the second person see the first person's rows, and the real rule stops it", async () => {
    const policies = [
      ["wellness_checkins_select", "app.wellness_checkins"],
      ["medications_select", "app.medications"],
      ["medication_logs_select", "app.medication_logs"],
      ["wellness_therapy_notes_select", "app.wellness_therapy_notes"]
    ] as const;
    try {
      for (const [p, t] of policies) await admin.query(`ALTER POLICY ${p} ON ${t} USING (true)`);
      const open = await countsFor("bob");
      expect(open.map((n, i) => n - expected("bob")[i]!)).toEqual(expected("alice"));
    } finally {
      for (const [p, t] of policies) {
        await admin.query(
          `ALTER POLICY ${p} ON ${t} USING (owner_user_id = app.current_actor_user_id())`
        );
      }
    }
    expect(await countsFor("bob")).toEqual(expected("bob"));
    expect(await countsFor("alice")).toEqual(expected("alice"));
  });
});
