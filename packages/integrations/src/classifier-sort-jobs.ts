import type { FastifyBaseLogger } from "fastify";
import { sql, type Kysely } from "kysely";
import type { PgBoss, WorkOptions } from "pg-boss";

import type { AccessContext, DataContextRunner, MossDatabase } from "@moss/db";
import { sendJob, toAccessContext, type QueueDefinition } from "@moss/jobs";
import type { IntegrationClassifierSortedBy } from "@moss/shared";

import { CLASSIFIER_ATTEMPT_LIVE_MS } from "./classifier-attempt.js";
import { enqueueClassifierPreparation } from "./classifier-preparation-jobs.js";
import type { ClassifierPreparationPort, PreparationChatModel } from "./classifier-preparation.js";
import { toolRiskInputs, toolSortFingerprint } from "./classifier-risk-inputs.js";
import {
  credentialMatcher,
  failedSortResults,
  freeReadableNames,
  planSortingCalls,
  resultsWithoutCall,
  runSortingCall,
  sortingTargets,
  withSortedBy,
  type SortingCallTool
} from "./classifier-sorting.js";
import { loadClassifierCheckCredential, type IntegrationsCipherSources } from "./credentials.js";
import { INTEGRATION_CLASSIFIER_SORT_QUEUE } from "./manifest.js";
import { IntegrationsRepository, type ConnectionRow } from "./repository.js";

/**
 * The sorting job (spec 8.2, #2984 R2.2). It runs on connection add, on a discovery refresh, when
 * the classifier switch turns on, on the owner's Try again, and from a sweep at worker start. It
 * runs whether the classifier is on or off, and queues a preparation run when it finishes.
 *
 * The payload carries the owner id, the connection id and the job kind only. Logs carry counts
 * and the connection id; they never carry tool text, the model's answer or the credential.
 */

export const INTEGRATION_CLASSIFIER_SORT_QUEUE_DEFINITION: QueueDefinition = {
  name: INTEGRATION_CLASSIFIER_SORT_QUEUE,
  options: {
    // One queued and one active job per key: a request that arrives mid-run still runs after it.
    policy: "stately",
    // A provider charge is never repeated automatically.
    retryLimit: 0,
    expireInSeconds: CLASSIFIER_ATTEMPT_LIVE_MS / 1000,
    deleteAfterSeconds: 300,
    retentionSeconds: 3600
  }
};

/**
 * `sort` sorts never-tried and stale tools. `retry` also re-sends tools whose sort failed.
 * `model_ready` also re-sends only tools whose sort failed for want of a model.
 */
export type ClassifierSortJobOp = "sort" | "retry" | "model_ready";

export interface ClassifierSortJobPayload {
  readonly actorUserId: string;
  /** The connection id. */
  readonly resourceId: string;
  readonly op: ClassifierSortJobOp;
}

export async function enqueueClassifierSort(
  boss: PgBoss,
  actorUserId: string,
  connectionId: string,
  op: ClassifierSortJobOp = "sort"
): Promise<void> {
  const payload: ClassifierSortJobPayload = { actorUserId, resourceId: connectionId, op };
  await sendJob(boss, INTEGRATION_CLASSIFIER_SORT_QUEUE, payload, {
    singletonKey: `classifier-${op}:${connectionId}`
  });
}

type SortLogger = Pick<FastifyBaseLogger, "info" | "warn">;

export interface ClassifierSortJobDeps {
  readonly dataContext: DataContextRunner;
  readonly port: ClassifierPreparationPort;
  readonly cipherSources: IntegrationsCipherSources;
  readonly repository?: IntegrationsRepository;
  readonly logger?: SortLogger;
  readonly now?: () => Date;
}

export type ClassifierSortJobOutcome =
  | { readonly status: "nothing_to_sort" }
  | { readonly status: "no_model" }
  | { readonly status: "credentials_paused" }
  | { readonly status: "sorted"; readonly calls: number; readonly written: number }
  | { readonly status: "stopped"; readonly calls: number; readonly written: number };

interface PreparedSort {
  readonly model: PreparationChatModel;
  readonly sortedBy: IntegrationClassifierSortedBy | null;
  readonly calls: readonly (readonly SortingCallTool[])[];
  readonly freeNames: ReadonlyMap<string, string>;
  readonly written: number;
}

/** The tools this run should sort, read from the row as it is now. */
function targetsFor(row: ConnectionRow, op: ClassifierSortJobOp, now: Date) {
  return sortingTargets({
    discoveredTools: row.discoveredTools,
    sort: row.classifierSort,
    retryFailed: op === "retry",
    retryNoModel: op === "model_ready",
    now
  });
}

/**
 * Sort one connection's tools. The first transaction reads the row, checks the credential and
 * settles tools that need no call. Each model call then runs in two transactions. The first locks
 * the row, keeps the call's tools that are still targets and marks them as a started call, so no
 * other run sends them and a call that never saves leaves them for Try again. The second makes
 * the call and writes its results, so one failed call never undoes another call's work.
 */
export async function runClassifierSortJob(
  deps: ClassifierSortJobDeps,
  accessContext: AccessContext,
  connectionId: string,
  op: ClassifierSortJobOp
): Promise<ClassifierSortJobOutcome> {
  const repository = deps.repository ?? new IntegrationsRepository();
  const now = deps.now ?? (() => new Date());

  const prepared = await deps.dataContext.withDataContext(
    accessContext,
    async (
      scopedDb
    ): Promise<PreparedSort | Exclude<ClassifierSortJobOutcome, { calls: number }>> => {
      const row = await repository.getConnection(scopedDb, connectionId);
      if (!row?.discoveredTools) return { status: "nothing_to_sort" };
      const targets = targetsFor(row, op, now());
      if (targets.length === 0) return { status: "nothing_to_sort" };

      // Without a model that can sort, every target fails with reason `no_model`, so the page can
      // say a model is missing. No provider was reached, so a `model_ready` run resends them once
      // a model is chosen; a run that still finds none leaves those failures as they are.
      const selection = await deps.port.selectDefaultChatModel(scopedDb);
      if (!selection?.structured) {
        if (op === "model_ready") return { status: "no_model" };
        await repository.saveClassifierToolSorts(
          scopedDb,
          connectionId,
          failedSortResults(targets, "no_model", now().toISOString())
        );
        return { status: "no_model" };
      }

      const credential = await loadClassifierCheckCredential(
        scopedDb,
        repository,
        connectionId,
        deps.cipherSources
      );
      if (credential === undefined) return { status: "credentials_paused" };

      const plan = planSortingCalls(targets, credentialMatcher(credential));
      const freeNames = freeReadableNames(row.discoveredTools);
      const settled = resultsWithoutCall(plan, freeNames, now().toISOString());
      if (settled.length > 0) {
        await repository.saveClassifierToolSorts(scopedDb, connectionId, settled);
      }
      return {
        model: selection.model,
        sortedBy: selection.displayNames ?? null,
        calls: plan.calls,
        freeNames,
        written: settled.length
      };
    }
  );
  if (!("model" in prepared)) return prepared;

  let written = prepared.written;
  let calls = 0;
  for (const planned of prepared.calls) {
    const call = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
      const row = await repository.getConnectionForUpdate(scopedDb, connectionId);
      if (!row) return [];
      const fingerprints = new Map(
        targetsFor(row, op, now()).map((tool) => [
          tool.name,
          toolSortFingerprint(toolRiskInputs(tool))
        ])
      );
      const kept = planned.filter(
        (entry) =>
          fingerprints.get(entry.tool.name) === toolSortFingerprint(toolRiskInputs(entry.tool))
      );
      if (kept.length > 0) {
        await repository.saveClassifierToolSorts(
          scopedDb,
          connectionId,
          failedSortResults(
            kept.map((entry) => entry.tool),
            "interrupted",
            now().toISOString()
          )
        );
      }
      return kept;
    });
    if (call.length === 0) continue;

    const results = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
      const callResults = await runSortingCall(
        scopedDb,
        call,
        prepared.model,
        deps.port,
        prepared.freeNames,
        now
      );
      if (!callResults) return null;
      const stamped = withSortedBy(callResults, prepared.sortedBy);
      await repository.saveClassifierToolSorts(scopedDb, connectionId, stamped);
      return stamped;
    });
    calls += 1;
    if (!results) return { status: "stopped", calls, written };
    written += results.length;
  }
  return { status: "sorted", calls, written };
}

/**
 * Queue a sort for every connection with a tool that has never been sorted. The listing function
 * returns ids only. Tools that failed are left for the owner's Try again.
 */
export async function sweepClassifierSorts(
  boss: PgBoss,
  rootDb: Kysely<MossDatabase>,
  logger?: SortLogger
): Promise<number> {
  const result = await sql<{ readonly owner_user_id: string; readonly connection_id: string }>`
    SELECT owner_user_id, connection_id FROM app.list_integration_connections_needing_sort()
  `.execute(rootDb);
  for (const row of result.rows) {
    await enqueueClassifierSort(boss, row.owner_user_id, row.connection_id);
  }
  logger?.info({ connections: result.rows.length }, "integrations: queued tool sorting sweep");
  return result.rows.length;
}

export interface RegisterClassifierSortWorkersDeps extends ClassifierSortJobDeps {
  readonly rootDb: Kysely<MossDatabase>;
  readonly workOptions?: WorkOptions;
}

function sortJobOp(op: unknown): ClassifierSortJobOp {
  return op === "retry" || op === "model_ready" ? op : "sort";
}

export async function registerClassifierSortWorkers(
  boss: PgBoss,
  deps: RegisterClassifierSortWorkersDeps
): Promise<readonly string[]> {
  const workerId = await boss.work<ClassifierSortJobPayload>(
    INTEGRATION_CLASSIFIER_SORT_QUEUE,
    deps.workOptions ?? { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error("pg-boss invoked tool sorting without a job");
      const op = sortJobOp(job.data.op);
      const outcome = await runClassifierSortJob(
        deps,
        toAccessContext(job),
        job.data.resourceId,
        op
      );
      deps.logger?.info(
        { connectionId: job.data.resourceId, op, ...outcome },
        "integrations: tool sorting finished"
      );
      // Preparation needs a current sort, so every sort is followed by one. The preparation job
      // stops at once when the connection's classifier switch is off.
      try {
        await enqueueClassifierPreparation(boss, job.data.actorUserId, job.data.resourceId);
      } catch (error) {
        deps.logger?.warn(
          {
            connectionId: job.data.resourceId,
            error: error instanceof Error ? error.message : "unknown"
          },
          "integrations: could not queue tool preparation"
        );
      }
    }
  );

  // The sweep is a catch-up, so a failure here never blocks the worker from starting.
  try {
    await sweepClassifierSorts(boss, deps.rootDb, deps.logger);
  } catch (error) {
    deps.logger?.warn(
      { error: error instanceof Error ? error.message : "unknown" },
      "integrations: tool sorting sweep failed"
    );
  }
  return [workerId];
}
