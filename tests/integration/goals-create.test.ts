import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { GoalsRepository } from "../../packages/goals/src/repository.js";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("goals repository creation", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  const repo = new GoalsRepository();

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
    dataContext = new DataContextRunner(appDb);
  });

  afterAll(async () => {
    await appDb.destroy();
  });

  it("creates a goal and evidence with database-generated ids", async () => {
    const access = { actorUserId: ids.userA, requestId: "req-goals-create" };

    const { goal, evidence } = await dataContext.withDataContext(access, async (scopedDb) => {
      const goal = await repo.create(scopedDb, ids.userA, {
        title: "Ship the thing",
        desiredOutcome: "It is shipped"
      });
      const evidence = await repo.addEvidence(scopedDb, ids.userA, goal.id, {
        evidenceKind: "progress",
        sourceKind: "manual",
        sourceLabel: "Manual note",
        summary: "Made progress"
      });
      return { goal, evidence };
    });

    expect(goal.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(evidence.goalId).toBe(goal.id);
  });
});
