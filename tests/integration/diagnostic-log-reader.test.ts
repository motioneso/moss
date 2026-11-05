import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";
import pg from "pg";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { readDiagnosticLogs } from "@moss/settings";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

// #3978 slice 2D: the reader behind the platform diagnostics logs section. Runs as the app role.

const adminA = "00000000-0000-4000-8000-000000003b01";
const adminB = "00000000-0000-4000-8000-000000003b02";
const plainUser = "00000000-0000-4000-8000-000000003b03";

let appDb: Kysely<MossDatabase>;
let appContext: DataContextRunner;
let boot: pg.Client;

const wide = () => ({
  limit: 10,
  since: new Date(Date.now() - 24 * 3600 * 1000),
  minLevel: "warn" as const
});

async function insert(opts: {
  owner?: string | null;
  message: string;
  level?: number;
  component?: string;
  ageMinutes?: number;
  context?: string;
  truncated?: boolean;
}): Promise<void> {
  await boot.query(
    `INSERT INTO app.diagnostic_log_records
       (occurred_at, process, level, component, owner_user_id, message, context, truncated)
     VALUES (now() - make_interval(mins => $1), 'worker', $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      opts.ageMinutes ?? 0,
      opts.level ?? 40,
      opts.component ?? "google-sync",
      opts.owner ?? null,
      opts.message,
      opts.context ?? "{}",
      opts.truncated ?? false
    ]
  );
}

function readAs(
  actor: string,
  overrides: Partial<{ minLevel: "warn" | "error" | "fatal"; since: Date; component: string }> = {}
) {
  return appContext.withDataContext(
    { actorUserId: actor, requestId: `req:logs-${actor}` },
    (scopedDb) => readDiagnosticLogs(scopedDb, { ...wide(), ...overrides })
  );
}

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  boot = new Client({ connectionString: connectionStrings.bootstrap });
  await boot.connect();
  await boot.query(
    `INSERT INTO app.users (id, email, name, is_instance_admin, is_bootstrap_owner, status) VALUES
      ($1, 'rd-a@example.test', 'Admin A', true, false, 'active'),
      ($2, 'rd-b@example.test', 'Admin B', true, false, 'active'),
      ($3, 'rd-plain@example.test', 'Plain', false, false, 'active')`,
    [adminA, adminB, plainUser]
  );
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  appContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
  await boot?.end();
});

describe("readDiagnosticLogs", () => {
  it("gives a non-admin nothing, with null coverage", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await insert({ owner: plainUser, message: "PLAIN-OWN-MARKER" });
    const section = await readAs(plainUser);
    expect(section.records).toEqual([]);
    expect(section.coverage).toEqual({ oldestAt: null, newestAt: null });
  });

  it("shows an admin their own text and only metadata for other or unowned rows", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await insert({ owner: adminA, message: "OWN-MARKER", context: '{"k":"CTX-SECRET-MARKER"}' });
    await insert({ owner: adminB, message: "OTHER-MARKER" });
    await insert({ owner: null, message: "UNOWNED-MARKER" });
    const section = await readAs(adminA);
    const text = JSON.stringify(section);
    expect(section.records).toHaveLength(3);
    expect(text).toContain("OWN-MARKER");
    expect(text).not.toContain("OTHER-MARKER");
    expect(text).not.toContain("UNOWNED-MARKER");
    expect(text).not.toContain("CTX-SECRET-MARKER");
    const other = section.records.filter((r) => !r.owned);
    expect(other.every((r) => r.message === null)).toBe(true);
    expect(other.some((r) => r.ownerKnown)).toBe(true);
    expect(other.some((r) => !r.ownerKnown)).toBe(true);
  });

  it("applies the level, component and time filters", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await insert({ owner: adminA, message: "warn-new", level: 40, component: "oauth" });
    await insert({ owner: adminA, message: "error-new", level: 50, component: "google-sync" });
    await insert({ owner: adminA, message: "old", level: 50, ageMinutes: 600 });
    const errors = await readAs(adminA, { minLevel: "error" });
    expect(errors.records.map((r) => r.level)).toEqual(["error", "error"]);
    const oauth = await readAs(adminA, { component: "oauth" });
    expect(oauth.records.map((r) => r.component)).toEqual(["oauth"]);
    const recent = await readAs(adminA, { since: new Date(Date.now() - 60 * 60 * 1000) });
    expect(recent.records.map((r) => r.message)).not.toContain("old");
  });

  it("caps at 10 and flags truncation", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    for (let i = 0; i < 25; i += 1) await insert({ owner: adminA, message: `row ${i}` });
    const section = await readAs(adminA);
    expect(section.records).toHaveLength(10);
    expect(section.truncated).toBe(true);
  });

  it("reports coverage, and nulls on an empty store", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    expect((await readAs(adminA)).coverage).toEqual({ oldestAt: null, newestAt: null });
    await insert({ owner: adminA, message: "x", ageMinutes: 30 });
    await insert({ owner: adminA, message: "y" });
    const cov = (await readAs(adminA)).coverage;
    expect(cov.oldestAt).not.toBeNull();
    expect(new Date(cov.newestAt!).getTime()).toBeGreaterThan(new Date(cov.oldestAt!).getTime());
  });

  it("cuts a long own message to 500 characters", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await insert({ owner: adminA, message: "m".repeat(2000) });
    const section = await readAs(adminA);
    expect(section.records[0]!.message).toHaveLength(500);
    expect(section.records[0]!.truncated).toBe(true);
  });

  it("reports the stored truncation flag, and false for a whole short message", async () => {
    await boot.query("DELETE FROM app.diagnostic_log_records");
    await insert({ owner: adminA, message: "whole", ageMinutes: 2 });
    await insert({ owner: adminA, message: "cut at storage", truncated: true, ageMinutes: 1 });
    await insert({ owner: adminB, message: "other owner cut", truncated: true });
    const byMessage = Object.fromEntries(
      (await readAs(adminA)).records.map((r) => [r.message ?? "hidden", r.truncated])
    );
    expect(byMessage).toMatchObject({ whole: false, "cut at storage": true, hidden: true });
  });
});
