/**
 * Workflow run persistence (#2013, slice 819-B).
 *
 * These cases guard the state rules the queue slice (#2014) will build on: a finished step
 * never moves again, a duplicate step insert is harmless, and nothing keeps a stale queue job
 * id once it stops being live work. Break any of those and a worker returning from a crash can
 * resurrect work the owner already cancelled.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { WorkflowsRepository, WorkflowStateError } from "@moss/workflows";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
let repo: WorkflowsRepository;

const userA = ids.userA;

function userAContext() {
  return { actorUserId: userA, requestId: "req:workflows-persistence-test" };
}

/** Every case starts from a fresh run so nothing depends on another case's leftovers. */
async function newRun(overrides?: { workflowId?: string; startStepId?: string }) {
  return dataContext.withDataContext(userAContext(), async (scopedDb) =>
    repo.createRun(scopedDb, {
      ownerUserId: userA,
      workflowId: overrides?.workflowId ?? `wf-${randomUUID()}`,
      workflowVersion: 1,
      moduleId: "workflows",
      startedBy: "user",
      inputJson: { reason: "integration test" },
      startStepId: overrides?.startStepId ?? "first-step"
    })
  );
}

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  dataContext = new DataContextRunner(appDb);
  repo = new WorkflowsRepository();
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("WorkflowsRepository", () => {
  it("creates a run together with its first step, both owned by the caller", async () => {
    const { run, firstStepRun } = await newRun({ startStepId: "collect-input" });

    expect(run.ownerUserId).toBe(userA);
    expect(run.status).toBe("pending");
    expect(run.startedBy).toBe("user");
    expect(firstStepRun.workflowRunId).toBe(run.id);
    expect(firstStepRun.ownerUserId).toBe(userA);
    expect(firstStepRun.stepId).toBe("collect-input");
    expect(firstStepRun.status).toBe("pending");
    expect(firstStepRun.attemptCount).toBe(0);

    const steps = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listStepRuns(scopedDb, userA, run.id)
    );
    expect(steps).toHaveLength(1);
    expect(steps[0]?.id).toBe(firstStepRun.id);
  });

  it("returns the existing row instead of a second one when the same step is inserted twice", async () => {
    const { run } = await newRun();

    const first = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.createStepRun(scopedDb, {
        workflowRunId: run.id,
        ownerUserId: userA,
        stepId: "review"
      })
    );
    const second = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.createStepRun(scopedDb, {
        workflowRunId: run.id,
        ownerUserId: userA,
        stepId: "review"
      })
    );

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.stepRun.id).toBe(first.stepRun.id);

    const steps = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listStepRuns(scopedDb, userA, run.id)
    );
    expect(steps.filter((step) => step.stepId === "review")).toHaveLength(1);
  });

  it("refuses to move a step out of a state that is already final", async () => {
    const settlers = [
      {
        finalStatus: "succeeded",
        settle: async (scopedDb: unknown, stepRunId: string) => {
          await repo.recordStepSuccess(scopedDb, stepRunId, { ok: true });
        }
      },
      {
        finalStatus: "failed",
        settle: async (scopedDb: unknown, stepRunId: string) => {
          await repo.recordStepFailure(scopedDb, stepRunId, "boom");
        }
      },
      {
        finalStatus: "cancelled",
        settle: async (scopedDb: unknown, _stepRunId: string, runId: string) => {
          await repo.cancelRun(scopedDb, userA, runId);
        }
      }
    ];

    for (const { finalStatus, settle } of settlers) {
      const { run, firstStepRun } = await newRun();

      await dataContext.withDataContext(userAContext(), async (scopedDb) => {
        await settle(scopedDb, firstStepRun.id, run.id);
      });

      const settled = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
        repo.listStepRuns(scopedDb, userA, run.id)
      );
      expect(settled[0]?.status).toBe(finalStatus);

      for (const move of ["markStepRunning", "suspendStepRun", "incrementStepAttempt"] as const) {
        const attempt = dataContext.withDataContext(userAContext(), async (scopedDb) =>
          repo[move](scopedDb, firstStepRun.id)
        );
        await expect(attempt).rejects.toBeInstanceOf(WorkflowStateError);
        await expect(attempt).rejects.toMatchObject({ code: "terminal-state" });
      }
    }
  });

  it("drops the stored queue job id as soon as a step stops being live work", async () => {
    for (const settle of ["suspend", "succeed", "cancel"] as const) {
      const { run, firstStepRun } = await newRun();

      const queued = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
        repo.setStepQueueJobId(scopedDb, firstStepRun.id, randomUUID())
      );
      expect(queued.queueJobId).not.toBeNull();

      const after = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
        if (settle === "suspend") return repo.suspendStepRun(scopedDb, firstStepRun.id);
        if (settle === "succeed") return repo.recordStepSuccess(scopedDb, firstStepRun.id, {});
        await repo.cancelRun(scopedDb, userA, run.id);
        const steps = await repo.listStepRuns(scopedDb, userA, run.id);
        return steps[0];
      });

      expect(after?.queueJobId).toBeNull();
    }
  });

  it("cancels the unfinished steps and waiting approvals with the run, and is safe to repeat", async () => {
    const { run, firstStepRun } = await newRun();

    await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      await repo.createStepRun(scopedDb, {
        workflowRunId: run.id,
        ownerUserId: userA,
        stepId: "second-step"
      });
      await repo.createApproval(scopedDb, {
        workflowRunId: run.id,
        stepRunId: firstStepRun.id,
        ownerUserId: userA,
        summary: "Send the email?"
      });
    });

    const first = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.cancelRun(scopedDb, userA, run.id)
    );
    expect(first.cancelled).toBe(true);
    expect(first.run?.status).toBe("cancelled");
    expect(first.cancelledStepRunCount).toBe(2);
    expect(first.cancelledApprovalCount).toBe(1);

    const again = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.cancelRun(scopedDb, userA, run.id)
    );
    expect(again.cancelled).toBe(false);
    expect(again.run?.status).toBe("cancelled");
    expect(again.cancelledStepRunCount).toBe(0);
    expect(again.cancelledApprovalCount).toBe(0);

    const approvals = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listApprovals(scopedDb, userA, run.id)
    );
    expect(approvals.every((approval) => approval.status === "cancelled")).toBe(true);
  });

  it("suspends the step while an approval waits, and answers it exactly once", async () => {
    const { run, firstStepRun } = await newRun();

    const approval = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.createApproval(scopedDb, {
        workflowRunId: run.id,
        stepRunId: firstStepRun.id,
        ownerUserId: userA,
        summary: "Charge the card?"
      })
    );
    expect(approval.status).toBe("pending");

    const suspended = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listStepRuns(scopedDb, userA, run.id)
    );
    expect(suspended[0]?.status).toBe("suspended");

    const resolved = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.resolveApproval(scopedDb, userA, approval.id, "approve")
    );
    expect(resolved.outcome).toBe("resolved");
    if (resolved.outcome === "resolved") {
      expect(resolved.approval.status).toBe("approved");
      expect(resolved.approval.resolvedByUserId).toBe(userA);
      expect(resolved.stepRun.status).toBe("queued");
      expect(resolved.stepRun.queueJobId).toBeNull();
    }

    const secondAnswer = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.resolveApproval(scopedDb, userA, approval.id, "deny")
    );
    expect(secondAnswer.outcome).toBe("not-pending");
  });

  it("refuses to put a finished step back on the queue when its approval is answered", async () => {
    // Answering an approval moves its step back to queued. That has to go through the same
    // guard every other step move goes through, or a step that had already failed while the
    // approval sat waiting would come back to life.
    const { run, firstStepRun } = await newRun();

    const approval = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.createApproval(scopedDb, {
        workflowRunId: run.id,
        stepRunId: firstStepRun.id,
        ownerUserId: userA,
        summary: "Charge the card?"
      })
    );

    await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.recordStepFailure(scopedDb, firstStepRun.id, "step-blew-up")
    );

    const attempt = dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.resolveApproval(scopedDb, userA, approval.id, "approve")
    );
    await expect(attempt).rejects.toBeInstanceOf(WorkflowStateError);
    await expect(attempt).rejects.toMatchObject({ code: "terminal-state" });

    // The whole answer runs in one transaction, so the approval is still waiting.
    const after = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listApprovals(scopedDb, userA, run.id)
    );
    expect(after[0]?.status).toBe("pending");

    const steps = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listStepRuns(scopedDb, userA, run.id)
    );
    expect(steps[0]?.status).toBe("failed");
  });

  it("rejects an oversized stored value with an error naming the field", async () => {
    const { run } = await newRun();
    const tooBig = { blob: "x".repeat(9000) };

    const attempt = dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.completeRun(scopedDb, userA, run.id, "succeeded", tooBig)
    );
    await expect(attempt).rejects.toBeInstanceOf(WorkflowStateError);
    await expect(attempt).rejects.toMatchObject({ code: "value-too-large" });
    await expect(attempt).rejects.toThrow(/resultJson/);
  });

  it("stores only a reference and a hash for an artifact, never its bytes", async () => {
    const { run, firstStepRun } = await newRun();

    const artifact = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.recordArtifact(scopedDb, {
        workflowRunId: run.id,
        stepRunId: firstStepRun.id,
        ownerUserId: userA,
        artifactRef: "vault://workflows/report.pdf",
        sha256: "a".repeat(64),
        contentType: "application/pdf",
        sizeBytes: 4096
      })
    );

    expect(artifact.artifactRef).toBe("vault://workflows/report.pdf");
    expect(artifact.sha256).toBe("a".repeat(64));
    expect(artifact.sizeBytes).toBe(4096);

    const listed = await dataContext.withDataContext(userAContext(), async (scopedDb) =>
      repo.listArtifacts(scopedDb, userA, run.id)
    );
    expect(listed).toHaveLength(1);

    // The bytes live in the vault. If a later change ever adds a content column here, this
    // fails loudly rather than quietly turning the run store into a second file store.
    const columns = await sql<{ column_name: string }>`
      select column_name from information_schema.columns
      where table_schema = 'app' and table_name = 'workflow_artifacts'
    `.execute(appDb);
    const columnNames = columns.rows.map((column) => column.column_name);
    expect(columnNames).not.toContain("content");
    expect(columnNames).not.toContain("content_bytes");
    expect(columnNames).not.toContain("data");
  });
});
