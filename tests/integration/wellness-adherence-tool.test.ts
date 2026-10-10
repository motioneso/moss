import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type { ToolContext } from "@moss/module-sdk";
import { PreferencesRepository } from "@moss/structured-state";
import { WellnessRepository, wellnessMedicationAdherenceExecute } from "@moss/wellness";

import { connectionStrings, resetEmptyFoundationDatabase } from "./test-database.js";

const { Client } = pg;

const userId = "00000000-0000-4000-8000-000000000a17";
const access = { actorUserId: userId, requestId: "req:wellness-adherence-tool" };
const toolCtx: ToolContext = { actorUserId: userId, requestId: "tool-req", chatSessionId: "" };

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;

beforeAll(async () => {
  await resetEmptyFoundationDatabase();
  const client = new Client({ connectionString: connectionStrings.bootstrap });
  await client.connect();
  try {
    await client.query(
      `INSERT INTO app.users (id, email, is_instance_admin)
       VALUES ($1, 'well-adherence-tool@example.test', false)`,
      [userId]
    );
  } finally {
    await client.end();
  }
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

// #3217 DOM-019
describe("wellness.medicationAdherence counts unlogged doses", () => {
  it("one taken dose out of seven expected daily doses is not 100 percent", async () => {
    const repo = new WellnessRepository();
    await dataContext.withDataContext(access, async (db) => {
      await new PreferencesRepository().upsert(db, "wellness.ai_consent_granted", true);
      const med = await repo.createMedication(
        db,
        { name: "DailyMed", frequencyType: "once_daily", scheduleTimes: ["08:00"] },
        "UTC"
      );
      const today = new Date();
      const scheduledFor = new Date(
        Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 3, 8, 0, 0)
      ).toISOString();
      await repo.logDose(db, med.id, { status: "taken", scheduledFor });
    });

    const result = await dataContext.withDataContext(access, (db) =>
      wellnessMedicationAdherenceExecute(db, {}, toolCtx)
    );

    expect(result.data).toMatchObject({ scheduled: 7, taken: 1, adherenceRate: 0.14 });
  });
});
