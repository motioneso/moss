/**
 * The only way this codebase reaches the workflow tables (#2013, slice 819-B).
 *
 * Every method takes the actor-scoped handle first and asserts it, so nothing here can run
 * without a row-security actor set. `withDataContext` (packages/db/src/data-context.ts:63)
 * has already opened a transaction and set the acting user by the time a method body runs —
 * do not open a nested one; `FOR UPDATE` locks inside a method are locks in that same
 * transaction.
 *
 * Nothing in this file enqueues a job, writes a file, or reads the vault. The queue and
 * worker are #2014; the artifact write port over VaultContext is #2015.
 */
import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { sql } from "kysely";
import {
  TERMINAL_RUN_STATUSES,
  TERMINAL_STEP_RUN_STATUSES,
  WORKFLOW_MAX_JSON_BYTES,
  WORKFLOW_RUN_LIST_MAX_LIMIT,
  WorkflowStateError,
  type CancelWorkflowRunResult,
  type CreateWorkflowApprovalInput,
  type CreateWorkflowRunInput,
  type CreateWorkflowRunResult,
  type CreateWorkflowStepRunInput,
  type CreateWorkflowStepRunResult,
  type RecordWorkflowArtifactInput,
  type ResolveWorkflowApprovalResult,
  type WorkflowApproval,
  type WorkflowApprovalDecision,
  type WorkflowArtifact,
  type WorkflowJson,
  type WorkflowRun,
  type WorkflowRunDetail,
  type WorkflowRunStatus,
  type WorkflowStepRun,
  type WorkflowStepRunStatus
} from "./types.js";

const WORKFLOW_STEP_STALE_AFTER_MS = 5 * 60 * 1000;

export class WorkflowsRepository {
  /**
   * Creates the run and its first step run together. Both start `pending`; nothing is
   * enqueued — a run only begins moving when the queue slice picks it up.
   */
  async createRun(
    scopedDb: unknown,
    input: CreateWorkflowRunInput
  ): Promise<CreateWorkflowRunResult> {
    assertDataContextDb(scopedDb);
    const runInput = assertBoundedJson(input.inputJson ?? {}, "inputJson");
    const stepInput = assertBoundedJson(input.startStepInputJson ?? {}, "startStepInputJson");

    const runRow = await scopedDb.db
      .insertInto("app.workflow_runs")
      .values({
        owner_user_id: input.ownerUserId,
        workflow_id: input.workflowId,
        workflow_version: input.workflowVersion,
        module_id: input.moduleId,
        status: "pending",
        started_by: input.startedBy,
        input_json: runInput
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    const stepRow = await scopedDb.db
      .insertInto("app.workflow_step_runs")
      .values({
        workflow_run_id: runRow.id,
        owner_user_id: input.ownerUserId,
        step_id: input.startStepId,
        status: "pending",
        input_json: stepInput
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return { run: rowToRun(runRow), firstStepRun: rowToStepRun(stepRow) };
  }

  async getRun(scopedDb: unknown, ownerUserId: string, runId: string): Promise<WorkflowRun | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.workflow_runs")
      .selectAll()
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .executeTakeFirst();
    return row ? rowToRun(row) : null;
  }

  async listRuns(
    scopedDb: unknown,
    ownerUserId: string,
    options?: { readonly status?: WorkflowRunStatus; readonly limit?: number }
  ): Promise<WorkflowRun[]> {
    assertDataContextDb(scopedDb);
    const limit = clampLimit(options?.limit);

    let query = scopedDb.db
      .selectFrom("app.workflow_runs")
      .selectAll()
      .where("owner_user_id", "=", ownerUserId);
    if (options?.status) query = query.where("status", "=", options.status);

    const rows = await query.orderBy("started_at", "desc").limit(limit).execute();
    return rows.map(rowToRun);
  }

  /** The run plus every child row a detail view needs, in one call. */
  async getRunDetail(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<WorkflowRunDetail | null> {
    assertDataContextDb(scopedDb);
    const run = await this.getRun(scopedDb, ownerUserId, runId);
    if (!run) return null;

    const [stepRuns, approvals, artifacts] = await Promise.all([
      this.listStepRuns(scopedDb, ownerUserId, runId),
      this.listApprovals(scopedDb, ownerUserId, runId),
      this.listArtifacts(scopedDb, ownerUserId, runId)
    ]);

    return { run, stepRuns, approvals, artifacts };
  }

  async listStepRuns(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<WorkflowStepRun[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.workflow_step_runs")
      .selectAll()
      .where("workflow_run_id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(rowToStepRun);
  }

  async getStepRun(
    scopedDb: unknown,
    ownerUserId: string,
    workflowRunId: string,
    stepRunId: string
  ): Promise<WorkflowStepRun | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.workflow_step_runs")
      .selectAll()
      .where("id", "=", stepRunId)
      .where("workflow_run_id", "=", workflowRunId)
      .where("owner_user_id", "=", ownerUserId)
      .executeTakeFirst();
    return row ? rowToStepRun(row) : null;
  }

  async getStepResult(
    scopedDb: unknown,
    ownerUserId: string,
    workflowRunId: string,
    stepId: string
  ): Promise<WorkflowJson | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.workflow_step_runs")
      .select(["status", "result_json"])
      .where("workflow_run_id", "=", workflowRunId)
      .where("owner_user_id", "=", ownerUserId)
      .where("step_id", "=", stepId)
      .executeTakeFirst();
    return row && row.status === "succeeded" ? (row.result_json as WorkflowJson) : null;
  }

  async listApprovals(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<WorkflowApproval[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.workflow_approvals")
      .selectAll()
      .where("workflow_run_id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(rowToApproval);
  }

  /**
   * Insert-or-return. The unique constraint on (workflow_run_id, step_id) means a duplicate
   * job delivery collides here; the queue slice (#2014) relies on getting the existing row
   * back with `created: false` rather than a null or a thrown error.
   */
  async createStepRun(
    scopedDb: unknown,
    input: CreateWorkflowStepRunInput
  ): Promise<CreateWorkflowStepRunResult> {
    assertDataContextDb(scopedDb);
    const stepInput = assertBoundedJson(input.inputJson ?? {}, "inputJson");

    const inserted = await scopedDb.db
      .insertInto("app.workflow_step_runs")
      .values({
        workflow_run_id: input.workflowRunId,
        owner_user_id: input.ownerUserId,
        step_id: input.stepId,
        status: "pending",
        input_json: stepInput
      })
      .onConflict((oc) => oc.columns(["workflow_run_id", "step_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return { stepRun: rowToStepRun(inserted), created: true };

    const existing = await scopedDb.db
      .selectFrom("app.workflow_step_runs")
      .selectAll()
      .where("workflow_run_id", "=", input.workflowRunId)
      .where("step_id", "=", input.stepId)
      .executeTakeFirstOrThrow();
    return { stepRun: rowToStepRun(existing), created: false };
  }

  async markStepRunning(scopedDb: unknown, stepRunId: string): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    return this.transitionStepRun(scopedDb, stepRunId, {
      status: "running",
      started_at: new Date()
    });
  }

  async claimStepRun(
    scopedDb: unknown,
    stepRunId: string,
    queueJobId: string
  ): Promise<WorkflowStepRun | null> {
    assertDataContextDb(scopedDb);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - WORKFLOW_STEP_STALE_AFTER_MS);
    const row = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({
        status: "running",
        attempt_count: sql<number>`app.workflow_step_runs.attempt_count + 1`,
        pgboss_job_id: queueJobId,
        started_at: now,
        updated_at: now
      })
      .where("id", "=", stepRunId)
      .where((eb) =>
        eb.or([
          eb("status", "in", ["pending", "queued"]),
          eb.and([
            eb("status", "=", "running"),
            eb.or([eb("started_at", "is", null), eb("started_at", "<", staleBefore)])
          ])
        ])
      )
      .returningAll()
      .executeTakeFirst();
    return row ? rowToStepRun(row) : null;
  }

  async queueStepRetry(
    scopedDb: unknown,
    stepRunId: string,
    errorCode: string
  ): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    return this.transitionStepRun(scopedDb, stepRunId, {
      status: "queued",
      error_code: errorCode,
      pgboss_job_id: null
    });
  }

  async markRunRunning(scopedDb: unknown, runId: string): Promise<WorkflowRun> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.workflow_runs")
      .set({ status: "running", updated_at: new Date() })
      .where("id", "=", runId)
      .where("status", "in", ["pending", "suspended"])
      .returningAll()
      .executeTakeFirst();
    if (row) return rowToRun(row);
    const existing = await scopedDb.db
      .selectFrom("app.workflow_runs")
      .selectAll()
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    return rowToRun(existing);
  }

  async suspendRun(scopedDb: unknown, runId: string): Promise<WorkflowRun> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.workflow_runs")
      .set({ status: "suspended", updated_at: new Date() })
      .where("id", "=", runId)
      .where("status", "not in", [...TERMINAL_RUN_STATUSES])
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToRun(row);
  }

  async lockRun(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<WorkflowRun | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.workflow_runs")
      .selectAll()
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .forUpdate()
      .executeTakeFirst();
    return row ? rowToRun(row) : null;
  }

  async recordStepSuccess(
    scopedDb: unknown,
    stepRunId: string,
    resultJson: WorkflowJson
  ): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    const bounded = assertBoundedJson(resultJson, "resultJson");
    return this.transitionStepRun(scopedDb, stepRunId, {
      status: "succeeded",
      result_json: bounded,
      error_code: null,
      completed_at: new Date()
    });
  }

  async recordStepFailure(
    scopedDb: unknown,
    stepRunId: string,
    errorCode: string,
    resultJson?: WorkflowJson
  ): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    if (errorCode.length > 200) {
      throw new WorkflowStateError(
        "value-too-large",
        "errorCode is longer than the 200 characters this module stores."
      );
    }
    const bounded = assertBoundedJson(resultJson ?? {}, "resultJson");
    return this.transitionStepRun(scopedDb, stepRunId, {
      status: "failed",
      error_code: errorCode,
      result_json: bounded,
      completed_at: new Date()
    });
  }

  async suspendStepRun(scopedDb: unknown, stepRunId: string): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    return this.transitionStepRun(scopedDb, stepRunId, {
      status: "suspended",
      suspended_at: new Date()
    });
  }

  /** Marks an unclaimed live step as queued while recording the job that will deliver it. */
  async setStepQueueJobId(
    scopedDb: unknown,
    stepRunId: string,
    queueJobId: string
  ): Promise<WorkflowStepRun | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({ status: "queued", pgboss_job_id: queueJobId, updated_at: new Date() })
      .where("id", "=", stepRunId)
      .where("status", "in", ["pending", "queued"])
      .where("pgboss_job_id", "is", null)
      .returningAll()
      .executeTakeFirst();
    return row ? rowToStepRun(row) : null;
  }

  async clearStepQueueJobId(scopedDb: unknown, stepRunId: string): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({ pgboss_job_id: null, updated_at: new Date() })
      .where("id", "=", stepRunId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw stepRunNotFound(stepRunId);
    return rowToStepRun(row);
  }

  /** Bumps the attempt counter and stamps the start time in the same write. */
  async incrementStepAttempt(scopedDb: unknown, stepRunId: string): Promise<WorkflowStepRun> {
    assertDataContextDb(scopedDb);
    const current = await this.requireStepRunRow(scopedDb, stepRunId);
    assertStepRunNotTerminal(current.status, stepRunId);

    const row = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({
        attempt_count: sql<number>`app.workflow_step_runs.attempt_count + 1`,
        started_at: new Date(),
        updated_at: new Date()
      })
      .where("id", "=", stepRunId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToStepRun(row);
  }

  async completeRun(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string,
    status: "succeeded" | "failed",
    resultJson: WorkflowJson
  ): Promise<WorkflowRun> {
    assertDataContextDb(scopedDb);
    const bounded = assertBoundedJson(resultJson, "resultJson");

    // Locked for the rest of this transaction for the same reason cancelRun locks: two
    // completions arriving at once must not both read the run as still live.
    const current = await scopedDb.db
      .selectFrom("app.workflow_runs")
      .select(["status"])
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw runNotFound(runId);
    if (TERMINAL_RUN_STATUSES.includes(current.status)) {
      throw new WorkflowStateError(
        "terminal-state",
        `Workflow run ${runId} is already ${current.status} and cannot be completed again.`
      );
    }

    const row = await scopedDb.db
      .updateTable("app.workflow_runs")
      .set({
        status,
        result_json: bounded,
        completed_at: new Date(),
        updated_at: new Date()
      })
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToRun(row);
  }

  /**
   * Cancels the run, every step run that had not finished, and every approval still waiting
   * for an answer. Cancelling a run that is already over reports that it did nothing rather
   * than throwing, so a repeated click or a retried request is harmless.
   */
  async cancelRun(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<CancelWorkflowRunResult> {
    assertDataContextDb(scopedDb);

    // Lock the run row for the rest of this transaction so two concurrent cancels cannot
    // both decide the run was live.
    const locked = await scopedDb.db
      .selectFrom("app.workflow_runs")
      .selectAll()
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) {
      return { cancelled: false, run: null, cancelledStepRunCount: 0, cancelledApprovalCount: 0 };
    }
    if (TERMINAL_RUN_STATUSES.includes(locked.status)) {
      return {
        cancelled: false,
        run: rowToRun(locked),
        cancelledStepRunCount: 0,
        cancelledApprovalCount: 0
      };
    }

    const now = new Date();

    const cancelledSteps = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({
        status: "cancelled",
        // A cancelled step must not keep a queue job id: a worker coming back later would
        // otherwise treat a stale job as live work.
        pgboss_job_id: null,
        completed_at: now,
        updated_at: now
      })
      .where("workflow_run_id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .where("status", "not in", [...TERMINAL_STEP_RUN_STATUSES])
      .returning("id")
      .execute();

    const cancelledApprovals = await scopedDb.db
      .updateTable("app.workflow_approvals")
      .set({ status: "cancelled", updated_at: now })
      .where("workflow_run_id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .where("status", "=", "pending")
      .returning("id")
      .execute();

    const run = await scopedDb.db
      .updateTable("app.workflow_runs")
      .set({ status: "cancelled", completed_at: now, updated_at: now })
      .where("id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .returningAll()
      .executeTakeFirstOrThrow();

    return {
      cancelled: true,
      run: rowToRun(run),
      cancelledStepRunCount: cancelledSteps.length,
      cancelledApprovalCount: cancelledApprovals.length
    };
  }

  /** Creates the waiting approval and suspends the step that is waiting on it. */
  async createApproval(
    scopedDb: unknown,
    input: CreateWorkflowApprovalInput
  ): Promise<WorkflowApproval> {
    assertDataContextDb(scopedDb);
    const details = assertBoundedJson(input.detailsJson ?? {}, "detailsJson");

    const row = await scopedDb.db
      .insertInto("app.workflow_approvals")
      .values({
        workflow_run_id: input.workflowRunId,
        step_run_id: input.stepRunId,
        owner_user_id: input.ownerUserId,
        status: "pending",
        summary: input.summary,
        details_json: details
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    await this.transitionStepRun(scopedDb, input.stepRunId, {
      status: "suspended",
      suspended_at: new Date()
    });

    return rowToApproval(row);
  }

  /**
   * Answers an approval exactly once. The update only matches a row still `pending`, so a
   * second answer changes nothing and comes back as "not-pending" for the route to turn into
   * a 409. The step moves from suspended to queued with its old queue job id cleared; the
   * work of actually continuing the run belongs to #2015.
   */
  async resolveApproval(
    scopedDb: unknown,
    actorUserId: string,
    approvalId: string,
    decision: WorkflowApprovalDecision
  ): Promise<ResolveWorkflowApprovalResult> {
    assertDataContextDb(scopedDb);

    const existing = await scopedDb.db
      .selectFrom("app.workflow_approvals")
      .selectAll()
      .where("id", "=", approvalId)
      .where("owner_user_id", "=", actorUserId)
      .executeTakeFirst();
    if (!existing) return { outcome: "not-found" };

    const now = new Date();
    const resolvedStatus = decision === "approve" ? "approved" : "denied";

    const approvalRow = await scopedDb.db
      .updateTable("app.workflow_approvals")
      .set({
        status: resolvedStatus,
        resolved_by_user_id: actorUserId,
        updated_at: now
      })
      .where("id", "=", approvalId)
      .where("owner_user_id", "=", actorUserId)
      .where("status", "=", "pending")
      .returningAll()
      .executeTakeFirst();
    if (!approvalRow) return { outcome: "not-pending" };

    // A denial is a completed approval outcome, not a failure: the step carries the decision
    // as its bounded result and goes back on the queue so edge routing can branch on it.
    //
    // Routed through transitionStepRun rather than writing the row directly, so a step that
    // somehow finished while its approval was still waiting cannot be put back on the queue.
    // That case raises a state error (422), and because the whole route runs in one
    // transaction the approval answer above rolls back with it.
    const stepRun = await this.transitionStepRun(scopedDb, approvalRow.step_run_id, {
      status: "queued",
      result_json: { status: resolvedStatus },
      // The old queue job is finished with; a fresh one is booked when #2015 continues the run.
      pgboss_job_id: null
    });

    return {
      outcome: "resolved",
      approval: rowToApproval(approvalRow),
      stepRun
    };
  }

  /**
   * Stores where an artifact lives and what it hashes to. Never bytes: the vault holds the
   * content and only VaultContext reads it.
   */
  async recordArtifact(
    scopedDb: unknown,
    input: RecordWorkflowArtifactInput
  ): Promise<WorkflowArtifact> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .insertInto("app.workflow_artifacts")
      .values({
        workflow_run_id: input.workflowRunId,
        step_run_id: input.stepRunId,
        owner_user_id: input.ownerUserId,
        artifact_ref: input.artifactRef,
        sha256: input.sha256,
        content_type: input.contentType,
        size_bytes: input.sizeBytes
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToArtifact(row);
  }

  async listArtifacts(
    scopedDb: unknown,
    ownerUserId: string,
    runId: string
  ): Promise<WorkflowArtifact[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.workflow_artifacts")
      .selectAll()
      .where("workflow_run_id", "=", runId)
      .where("owner_user_id", "=", ownerUserId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(rowToArtifact);
  }

  private async requireStepRunRow(scopedDb: DataContextDb, stepRunId: string) {
    const row = await scopedDb.db
      .selectFrom("app.workflow_step_runs")
      .selectAll()
      .where("id", "=", stepRunId)
      .executeTakeFirst();
    if (!row) throw stepRunNotFound(stepRunId);
    return row;
  }

  /**
   * The one place a step run changes state. Refuses a move out of a terminal state, and
   * clears the queue job id on every move into terminal, suspended or cancelled.
   */
  private async transitionStepRun(
    scopedDb: DataContextDb,
    stepRunId: string,
    changes: {
      status: WorkflowStepRunStatus;
      result_json?: WorkflowJson;
      error_code?: string | null;
      pgboss_job_id?: string | null;
      started_at?: Date;
      suspended_at?: Date;
      completed_at?: Date;
    }
  ): Promise<WorkflowStepRun> {
    const current = await this.requireStepRunRow(scopedDb, stepRunId);
    assertStepRunNotTerminal(current.status, stepRunId);

    const clearsQueueJob =
      TERMINAL_STEP_RUN_STATUSES.includes(changes.status) || changes.status === "suspended";

    const row = await scopedDb.db
      .updateTable("app.workflow_step_runs")
      .set({
        ...changes,
        ...(clearsQueueJob ? { pgboss_job_id: null } : {}),
        updated_at: new Date()
      })
      .where("id", "=", stepRunId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToStepRun(row);
  }
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return WORKFLOW_RUN_LIST_MAX_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(Math.floor(limit), WORKFLOW_RUN_LIST_MAX_LIMIT);
}

/**
 * Checked here as well as by the database CHECK constraint so the caller sees which field
 * was too big rather than a raw constraint violation.
 */
function assertBoundedJson(value: WorkflowJson, fieldName: string): WorkflowJson {
  const size = Buffer.byteLength(JSON.stringify(value ?? {}), "utf8");
  if (size > WORKFLOW_MAX_JSON_BYTES) {
    throw new WorkflowStateError(
      "value-too-large",
      `${fieldName} is ${size} bytes, over the ${WORKFLOW_MAX_JSON_BYTES}-byte limit for ` +
        `workflow metadata. Store large values as a vault artifact and reference them instead.`
    );
  }
  return value;
}

function assertStepRunNotTerminal(status: WorkflowStepRunStatus, stepRunId: string): void {
  if (TERMINAL_STEP_RUN_STATUSES.includes(status)) {
    throw new WorkflowStateError(
      "terminal-state",
      `Workflow step run ${stepRunId} is ${status}, which is final; it cannot change state again.`
    );
  }
}

function stepRunNotFound(stepRunId: string): WorkflowStateError {
  return new WorkflowStateError("not-found", `Workflow step run ${stepRunId} was not found.`);
}

function runNotFound(runId: string): WorkflowStateError {
  return new WorkflowStateError("not-found", `Workflow run ${runId} was not found.`);
}

interface WorkflowRunRow {
  id: string;
  owner_user_id: string;
  workflow_id: string;
  workflow_version: number;
  module_id: string;
  status: WorkflowRunStatus;
  started_by: "user" | "module" | "system";
  input_json: Record<string, unknown>;
  result_json: Record<string, unknown>;
  started_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    workflowId: row.workflow_id,
    workflowVersion: Number(row.workflow_version),
    moduleId: row.module_id,
    status: row.status,
    startedBy: row.started_by,
    inputJson: row.input_json,
    resultJson: row.result_json,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface WorkflowStepRunRow {
  id: string;
  workflow_run_id: string;
  owner_user_id: string;
  step_id: string;
  status: WorkflowStepRunStatus;
  attempt_count: number;
  input_json: Record<string, unknown>;
  result_json: Record<string, unknown>;
  error_code: string | null;
  pgboss_job_id: string | null;
  started_at: Date | null;
  suspended_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToStepRun(row: WorkflowStepRunRow): WorkflowStepRun {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    ownerUserId: row.owner_user_id,
    stepId: row.step_id,
    status: row.status,
    attemptCount: Number(row.attempt_count),
    inputJson: row.input_json,
    resultJson: row.result_json,
    errorCode: row.error_code,
    queueJobId: row.pgboss_job_id,
    startedAt: row.started_at,
    suspendedAt: row.suspended_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface WorkflowApprovalRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string;
  owner_user_id: string;
  status: WorkflowApproval["status"];
  summary: string;
  details_json: Record<string, unknown>;
  resolved_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function rowToApproval(row: WorkflowApprovalRow): WorkflowApproval {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    ownerUserId: row.owner_user_id,
    status: row.status,
    summary: row.summary,
    detailsJson: row.details_json,
    resolvedByUserId: row.resolved_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

interface WorkflowArtifactRow {
  id: string;
  workflow_run_id: string;
  step_run_id: string | null;
  owner_user_id: string;
  artifact_ref: string;
  sha256: string;
  content_type: string;
  size_bytes: string | number;
  created_at: Date;
  updated_at: Date;
}

function rowToArtifact(row: WorkflowArtifactRow): WorkflowArtifact {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    stepRunId: row.step_run_id,
    ownerUserId: row.owner_user_id,
    artifactRef: row.artifact_ref,
    sha256: row.sha256,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
