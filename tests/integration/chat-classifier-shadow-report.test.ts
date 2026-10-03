import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ClassifierShadowRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2957: the temporary shadow report counts the viewer's own classifier shadow records over
// 7/30/90 days. Every number and every disagreement row must stay inside the caller's own
// rows: another owner (even a thread-share recipient) and an admin never appear.

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new ClassifierShadowRepository();

type SeedRow = {
  readonly turnId: string;
  readonly decision: "would_handle" | "declined";
  readonly moduleId: string | null;
  readonly toolName: string | null;
  readonly confidence: number | null;
  readonly comparisonStatus: "match" | "mismatch" | "unobserved" | "no_model_tool";
  readonly modelToolId: string | null;
  readonly daysAgo: number;
};

const seed = async (actorUserId: string, row: SeedRow): Promise<void> => {
  await dataContext.withDataContext(
    { actorUserId, requestId: "shadow-report-test" },
    async (db) => {
      await sql`
      INSERT INTO app.chat_classifier_shadow_records
        (owner_user_id, turn_id, message_text, gate_mode, classifier_config_id,
         classifier_config_version, threshold_version, decision, module_id, tool_name,
         confidence, comparison_status, model_tool_id, created_at)
      VALUES (${actorUserId}::uuid, ${row.turnId}, 'seed text', 'shadow', 'cfg-1',
        'v1', 't1', ${row.decision}, ${row.moduleId}, ${row.toolName},
        ${row.confidence}, ${row.comparisonStatus}, ${row.modelToolId},
        now() - (${row.daysAgo} || ' days')::interval)
    `.execute(db.db);
    }
  );
};

const reportAs = (actorUserId: string, days: 7 | 30 | 90) =>
  dataContext.withDataContext({ actorUserId, requestId: "shadow-report-test" }, (db) =>
    repository.getReportForOwner(db, { days })
  );

const tag = (suffix: string) => `report-${suffix}-${randomUUID()}`;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("classifier shadow report (#2957)", () => {
  it("counts the caller's own rows in window and shows only their disagreements", async () => {
    const a1 = tag("a1");
    const a2 = tag("a2");
    const a3 = tag("a3");
    const a4 = tag("a4");
    const a5 = tag("a5");
    const b1 = tag("b1");
    await seed(ids.userA, {
      turnId: a1,
      decision: "would_handle",
      moduleId: "calendar",
      toolName: "listVisibleEvents",
      confidence: 0.9,
      comparisonStatus: "match",
      modelToolId: "calendar.listvisibleevents",
      daysAgo: 1
    });
    await seed(ids.userA, {
      turnId: a2,
      decision: "would_handle",
      moduleId: "calendar",
      toolName: "listVisibleEvents",
      confidence: 0.8,
      comparisonStatus: "mismatch",
      modelToolId: "tasks.create",
      daysAgo: 2
    });
    // The classifier declined but the model used a tool: a miss.
    await seed(ids.userA, {
      turnId: a3,
      decision: "declined",
      moduleId: null,
      toolName: null,
      confidence: null,
      comparisonStatus: "unobserved",
      modelToolId: "tasks.create",
      daysAgo: 3
    });
    // Declined and the model used nothing: checked only.
    await seed(ids.userA, {
      turnId: a4,
      decision: "declined",
      moduleId: null,
      toolName: null,
      confidence: null,
      comparisonStatus: "no_model_tool",
      modelToolId: null,
      daysAgo: 4
    });
    // 40 days old: outside the 30-day window, inside the 90-day window.
    await seed(ids.userA, {
      turnId: a5,
      decision: "would_handle",
      moduleId: "calendar",
      toolName: "listVisibleEvents",
      confidence: 0.95,
      comparisonStatus: "match",
      modelToolId: "calendar.listvisibleevents",
      daysAgo: 40
    });
    await seed(ids.userB, {
      turnId: b1,
      decision: "would_handle",
      moduleId: "calendar",
      toolName: "listVisibleEvents",
      confidence: 0.7,
      comparisonStatus: "mismatch",
      modelToolId: "tasks.create",
      daysAgo: 1
    });

    const thirty = await reportAs(ids.userA, 30);
    expect(thirty.days).toBe(30);
    expect(thirty.checked).toBe(4);
    expect(thirty.pickedTool).toBe(2);
    expect(thirty.comparable).toBe(2);
    expect(thirty.agreed).toBe(1);
    expect(thirty.missedTool).toBe(1);
    expect(thirty.disagreements).toHaveLength(1);
    expect(thirty.disagreements[0]).toMatchObject({
      classifierTool: "calendar.listvisibleevents",
      modelTool: "tasks.create",
      confidence: 0.8
    });

    const ninety = await reportAs(ids.userA, 90);
    expect(ninety.checked).toBe(5);
    expect(ninety.pickedTool).toBe(3);
    expect(ninety.comparable).toBe(3);
    expect(ninety.agreed).toBe(2);
    expect(ninety.missedTool).toBe(1);
  });

  it("never shows another owner's rows, even to an admin", async () => {
    // Distinctive confidences tell the two owners' rows apart in a shared database.
    await seed(ids.userA, {
      turnId: tag("mine"),
      decision: "would_handle",
      moduleId: "reportprobe",
      toolName: "probeAction",
      confidence: 0.61,
      comparisonStatus: "mismatch",
      modelToolId: "tasks.create",
      daysAgo: 0
    });
    await seed(ids.userB, {
      turnId: tag("theirs"),
      decision: "would_handle",
      moduleId: "reportprobe",
      toolName: "probeAction",
      confidence: 0.62,
      comparisonStatus: "mismatch",
      modelToolId: "tasks.create",
      daysAgo: 0
    });

    const seenByA = await reportAs(ids.userA, 30);
    const aConfidences = seenByA.disagreements.map((d) => d.confidence);
    expect(aConfidences).toContain(0.61);
    expect(aConfidences).not.toContain(0.62);

    const seenByB = await reportAs(ids.userB, 30);
    const bConfidences = seenByB.disagreements.map((d) => d.confidence);
    expect(bConfidences).toContain(0.62);
    expect(bConfidences).not.toContain(0.61);

    const seenByAdmin = await reportAs(ids.adminUser, 30);
    expect(seenByAdmin.checked).toBe(0);
    expect(seenByAdmin.disagreements).toEqual([]);
  });
});
