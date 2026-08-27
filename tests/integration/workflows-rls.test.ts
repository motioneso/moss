/**
 * Two-owner isolation for workflow run state (#2013, slice 819-B).
 *
 * This is the security bar for the slice: one person's workflow runs, steps, approvals and
 * artifact records must be invisible and untouchable to anyone else, even though every one of
 * those rows is written by the same shared application role. The repository also filters by
 * owner in its own SQL, so each case checks the raw table with no owner filter as well —
 * otherwise a passing test would only prove the WHERE clause works, not the database rule
 * underneath it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { WorkflowsRepository } from "@moss/workflows";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let workerDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let workerDataContext: DataContextRunner;
let repo: WorkflowsRepository;

const userA = ids.userA;
const userB = ids.userB;

function contextFor(actorUserId: string) {
  return { actorUserId, requestId: `req:workflows-rls-${actorUserId}` };
}

interface OwnedRows {
  runId: string;
  stepRunId: string;
  approvalId: string;
  artifactId: string;
}

let owned: OwnedRows;

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  workerDataContext = new DataContextRunner(workerDb);
  repo = new WorkflowsRepository();

  owned = await dataContext.withDataContext(contextFor(userA), async (scopedDb) => {
    const { run, firstStepRun } = await repo.createRun(scopedDb, {
      ownerUserId: userA,
      workflowId: `wf-${randomUUID()}`,
      workflowVersion: 1,
      moduleId: "workflows",
      startedBy: "user",
      inputJson: { secret: "only user A should ever see this" },
      startStepId: "first-step"
    });
    const approval = await repo.createApproval(scopedDb, {
      workflowRunId: run.id,
      stepRunId: firstStepRun.id,
      ownerUserId: userA,
      summary: "Approve the transfer?"
    });
    const artifact = await repo.recordArtifact(scopedDb, {
      workflowRunId: run.id,
      stepRunId: firstStepRun.id,
      ownerUserId: userA,
      artifactRef: "vault://workflows/user-a-report.pdf",
      sha256: "b".repeat(64),
      contentType: "application/pdf",
      sizeBytes: 128
    });
    return {
      runId: run.id,
      stepRunId: firstStepRun.id,
      approvalId: approval.id,
      artifactId: artifact.id
    };
  });
});

afterAll(async () => {
  await appDb?.destroy();
  await workerDb?.destroy();
});

describe("workflow run state is owner-only", () => {
  it("forces row security on every workflow table, so even the table owner obeys it", async () => {
    const tables = await sql<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`
      SELECT relname, relrowsecurity, relforcerowsecurity
      FROM pg_class
      WHERE oid IN (
        'app.workflow_runs'::regclass,
        'app.workflow_step_runs'::regclass,
        'app.workflow_approvals'::regclass,
        'app.workflow_artifacts'::regclass
      )
      ORDER BY relname
    `.execute(appDb);

    expect(tables.rows).toHaveLength(4);
    for (const table of tables.rows) {
      expect(table.relrowsecurity).toBe(true);
      expect(table.relforcerowsecurity).toBe(true);
    }
  });

  it("gives the other person nothing back from any of the four tables", async () => {
    await dataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      const db = (scopedDb as { db: Kysely<MossDatabase> }).db;

      const runs = await db.selectFrom("app.workflow_runs").selectAll().execute();
      expect(runs).toEqual([]);

      const steps = await db.selectFrom("app.workflow_step_runs").selectAll().execute();
      expect(steps).toEqual([]);

      const approvals = await db.selectFrom("app.workflow_approvals").selectAll().execute();
      expect(approvals).toEqual([]);

      const artifacts = await db.selectFrom("app.workflow_artifacts").selectAll().execute();
      expect(artifacts).toEqual([]);
    });
  });

  it("hides the run from the other person's list and direct read", async () => {
    await dataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      expect(await repo.listRuns(scopedDb, userB)).toEqual([]);
      expect(await repo.getRun(scopedDb, userB, owned.runId)).toBeNull();
      expect(await repo.getRunDetail(scopedDb, userB, owned.runId)).toBeNull();
      expect(await repo.listStepRuns(scopedDb, userB, owned.runId)).toEqual([]);
      expect(await repo.listApprovals(scopedDb, userB, owned.runId)).toEqual([]);
      expect(await repo.listArtifacts(scopedDb, userB, owned.runId)).toEqual([]);
    });
  });

  it("does not let the other person read the run by guessing its owner", async () => {
    // The owner id is not a secret — it appears in URLs and job payloads elsewhere. Passing
    // user A's id while acting as user B must still come back empty, because the database
    // rule keys off who is acting, not off what the caller asked for.
    await dataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      expect(await repo.getRun(scopedDb, userA, owned.runId)).toBeNull();
      expect(await repo.getRunDetail(scopedDb, userA, owned.runId)).toBeNull();
      expect(await repo.listRuns(scopedDb, userA)).toEqual([]);
    });
  });

  it("does not let the other person cancel the run or answer the approval", async () => {
    await dataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      const cancel = await repo.cancelRun(scopedDb, userB, owned.runId);
      expect(cancel.cancelled).toBe(false);
      expect(cancel.run).toBeNull();

      const resolve = await repo.resolveApproval(scopedDb, userB, owned.approvalId, "approve");
      expect(resolve.outcome).toBe("not-found");
    });

    // Nothing moved.
    await dataContext.withDataContext(contextFor(userA), async (scopedDb) => {
      const run = await repo.getRun(scopedDb, userA, owned.runId);
      expect(run?.status).toBe("pending");
      const approvals = await repo.listApprovals(scopedDb, userA, owned.runId);
      expect(approvals[0]?.id).toBe(owned.approvalId);
      expect(approvals[0]?.status).toBe("pending");
    });
  });

  it("blocks the other person from writing a row that claims to belong to the owner", async () => {
    await dataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      const attempt = repo.createStepRun(scopedDb, {
        workflowRunId: owned.runId,
        ownerUserId: userA,
        stepId: "smuggled-step"
      });
      await expect(attempt).rejects.toThrow();
    });

    await dataContext.withDataContext(contextFor(userA), async (scopedDb) => {
      const steps = await repo.listStepRuns(scopedDb, userA, owned.runId);
      expect(steps).toHaveLength(1);
      expect(steps[0]?.id).toBe(owned.stepRunId);
    });
  });

  it("scopes the background worker to whoever it is acting as, same as the app", async () => {
    // The background job runner connects as a different database role from the web app. That
    // role used to be allowed to read and write every row on these four tables. It does not
    // need that: the job runner always sets who it is acting as before a handler runs, and
    // refuses a job that does not say. Seven of the step-changing methods in the repository
    // find a step by its id alone, so this database rule is the only thing standing between a
    // wrong id and someone else's step.
    await workerDataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      const db = (scopedDb as { db: Kysely<MossDatabase> }).db;

      expect(await db.selectFrom("app.workflow_runs").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("app.workflow_step_runs").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("app.workflow_approvals").selectAll().execute()).toEqual([]);
      expect(await db.selectFrom("app.workflow_artifacts").selectAll().execute()).toEqual([]);
    });

    // And it cannot change what it cannot see, even naming the row by its exact id.
    await workerDataContext.withDataContext(contextFor(userB), async (scopedDb) => {
      const db = (scopedDb as { db: Kysely<MossDatabase> }).db;

      const touchedRuns = await db
        .updateTable("app.workflow_runs")
        .set({ status: "cancelled" })
        .where("id", "=", owned.runId)
        .returning("id")
        .execute();
      expect(touchedRuns).toEqual([]);

      const touchedSteps = await db
        .updateTable("app.workflow_step_runs")
        .set({ status: "succeeded" })
        .where("id", "=", owned.stepRunId)
        .returning("id")
        .execute();
      expect(touchedSteps).toEqual([]);
    });

    // Nothing moved for the owner.
    await dataContext.withDataContext(contextFor(userA), async (scopedDb) => {
      const detail = await repo.getRunDetail(scopedDb, userA, owned.runId);
      expect(detail?.run.status).toBe("pending");
      expect(detail?.stepRuns[0]?.status).toBe("suspended");
    });
  });

  it("still lets the worker reach the rows of the person it is acting as", async () => {
    await workerDataContext.withDataContext(contextFor(userA), async (scopedDb) => {
      const detail = await repo.getRunDetail(scopedDb, userA, owned.runId);
      expect(detail?.run.id).toBe(owned.runId);
      expect(detail?.stepRuns.map((step) => step.id)).toEqual([owned.stepRunId]);
      expect(detail?.approvals.map((approval) => approval.id)).toEqual([owned.approvalId]);
      expect(detail?.artifacts.map((artifact) => artifact.id)).toEqual([owned.artifactId]);
    });
  });

  it("still shows the owner their own rows across all four tables", async () => {
    await dataContext.withDataContext(contextFor(userA), async (scopedDb) => {
      const detail = await repo.getRunDetail(scopedDb, userA, owned.runId);
      expect(detail?.run.id).toBe(owned.runId);
      expect(detail?.stepRuns.map((step) => step.id)).toEqual([owned.stepRunId]);
      expect(detail?.approvals.map((approval) => approval.id)).toEqual([owned.approvalId]);
      expect(detail?.artifacts.map((artifact) => artifact.id)).toEqual([owned.artifactId]);
    });
  });
});
