import type { FastifyBaseLogger } from "fastify";
import type { PgBoss, WorkOptions } from "pg-boss";

import type { AccessContext, DataContextRunner } from "@moss/db";
import { sendJob, toAccessContext, type QueueDefinition } from "@moss/jobs";

import { toolDefinitionFingerprint } from "./classifier-fingerprint.js";
import {
  preparationJobTargets,
  prepareClassifierTool,
  type ClassifierPreparationPort,
  type PreparationChatModel
} from "./classifier-preparation.js";
import {
  preparationHasRoom,
  type ClassifierPreparationFailureReason
} from "./classifier-settings.js";
import { credentialMatcher, type CredentialMatcher } from "./classifier-sorting.js";
import { loadClassifierCheckCredential, type IntegrationsCipherSources } from "./credentials.js";
import { INTEGRATION_CLASSIFIER_PREPARE_QUEUE } from "./manifest.js";
import { IntegrationsRepository, type ConnectionRow } from "./repository.js";

/**
 * The preparation job (spec 8.4, #2984 R2.4). It runs when the classifier switch turns on, after
 * every sort while the switch is on, and on the owner's Try again. Each prepared tool is saved
 * directly; a tool that fails waits for Try again.
 *
 * The payload carries the owner id, the connection id and the job kind only. Logs carry counts
 * and the connection id; they never carry tool text, the model's answer or the credential.
 */

export const INTEGRATION_CLASSIFIER_PREPARE_QUEUE_DEFINITION: QueueDefinition = {
  name: INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
  options: {
    // One queued and one active job per key: a request that arrives mid-run still runs after it.
    policy: "stately",
    // A provider charge is never repeated automatically.
    retryLimit: 0,
    expireInSeconds: 1800,
    deleteAfterSeconds: 300,
    retentionSeconds: 3600
  }
};

/** `prepare` drafts unprepared and changed tools. `retry` also re-sends tools that failed. */
export type ClassifierPreparationJobOp = "prepare" | "retry";

export interface ClassifierPreparationJobPayload {
  readonly actorUserId: string;
  /** The connection id. */
  readonly resourceId: string;
  readonly op: ClassifierPreparationJobOp;
}

export async function enqueueClassifierPreparation(
  boss: PgBoss,
  actorUserId: string,
  connectionId: string,
  op: ClassifierPreparationJobOp = "prepare"
): Promise<void> {
  const payload: ClassifierPreparationJobPayload = { actorUserId, resourceId: connectionId, op };
  await sendJob(boss, INTEGRATION_CLASSIFIER_PREPARE_QUEUE, payload, {
    singletonKey: `classifier-${op}:${connectionId}`
  });
}

type PreparationLogger = Pick<FastifyBaseLogger, "info" | "warn">;

export interface ClassifierPreparationJobDeps {
  readonly dataContext: DataContextRunner;
  readonly port: ClassifierPreparationPort;
  readonly cipherSources: IntegrationsCipherSources;
  readonly repository?: IntegrationsRepository;
  readonly logger?: PreparationLogger;
  readonly now?: () => Date;
}

export type ClassifierPreparationJobOutcome =
  | { readonly status: "switched_off" }
  | { readonly status: "nothing_to_prepare" }
  | { readonly status: "no_model" }
  | { readonly status: "credentials_paused" }
  | { readonly status: "prepared"; readonly prepared: number; readonly failed: number }
  | { readonly status: "stopped"; readonly prepared: number; readonly failed: number };

interface PreparationRun {
  readonly model: PreparationChatModel;
  readonly matcher: CredentialMatcher;
  readonly toolNames: readonly string[];
}

/** The connection's tools this run should prepare, read from the row as it is now. */
function targetsFor(row: ConnectionRow, op: ClassifierPreparationJobOp) {
  return preparationJobTargets({
    discoveredTools: row.discoveredTools,
    preparation: row.classifierPreparation,
    sort: row.classifierSort,
    keptOut: row.classifierKeptOutTools,
    curation: {
      enabledGroups: row.enabledGroups,
      enabledTools: row.enabledTools,
      mutedTools: row.mutedTools
    },
    retryFailed: op === "retry"
  });
}

function classifierActive(row: ConnectionRow): boolean {
  return row.enabled && row.classifierEnabled && row.lastError === null;
}

/**
 * Prepare one connection's tools. The first transaction reads the row, picks the targets, selects
 * the model and loads the credential for the check. Each tool then runs in its own transaction,
 * which re-reads the row so a tool switched off, kept out or changed mid-run is skipped, and saves
 * its own result.
 */
export async function runClassifierPreparationJob(
  deps: ClassifierPreparationJobDeps,
  accessContext: AccessContext,
  connectionId: string,
  op: ClassifierPreparationJobOp
): Promise<ClassifierPreparationJobOutcome> {
  const repository = deps.repository ?? new IntegrationsRepository();
  const now = deps.now ?? (() => new Date());

  const run = await deps.dataContext.withDataContext(
    accessContext,
    async (
      scopedDb
    ): Promise<PreparationRun | Exclude<ClassifierPreparationJobOutcome, { prepared: number }>> => {
      const row = await repository.getConnection(scopedDb, connectionId);
      if (!row || !classifierActive(row)) return { status: "switched_off" };
      const targets = targetsFor(row, op);
      if (targets.length === 0) return { status: "nothing_to_prepare" };

      const selection = await deps.port.selectDefaultChatModel(scopedDb);
      if (!selection?.structured) return { status: "no_model" };

      const credential = await loadClassifierCheckCredential(
        scopedDb,
        repository,
        connectionId,
        deps.cipherSources
      );
      if (credential === undefined) return { status: "credentials_paused" };

      return {
        model: selection.model,
        matcher: credentialMatcher(credential),
        toolNames: targets.map((tool) => tool.name)
      };
    }
  );
  if (!("model" in run)) return run;

  let prepared = 0;
  let failed = 0;
  for (const toolName of run.toolNames) {
    const step = await deps.dataContext.withDataContext(accessContext, async (scopedDb) => {
      const row = await repository.getConnection(scopedDb, connectionId);
      if (!row || !classifierActive(row)) return "switched_off" as const;
      const tool = targetsFor(row, op).find((candidate) => candidate.name === toolName);
      if (!tool) return "skipped" as const;
      const fail = async (reason: ClassifierPreparationFailureReason) => {
        await repository.saveClassifierPreparationFailure(scopedDb, connectionId, toolName, {
          reason,
          definitionFingerprint: toolDefinitionFingerprint(tool),
          failedAt: now().toISOString()
        });
      };

      // A full preparation store cannot take this tool, so it fails before any model charge.
      if (!preparationHasRoom(row.classifierPreparation, toolName)) {
        await fail("too_many_tools");
        return "failed" as const;
      }

      const outcome = await prepareClassifierTool(
        scopedDb,
        tool,
        run.model,
        deps.port,
        run.matcher
      );
      if (outcome.kind === "prepared") {
        const saved = await repository.saveClassifierToolReview(scopedDb, connectionId, toolName, {
          optIn: true,
          reviewedRisk: null,
          description: outcome.entry.description,
          arguments: outcome.entry.arguments,
          replyTemplate: outcome.entry.replyTemplate,
          reviewedFingerprint: outcome.entry.definitionFingerprint
        });
        if (saved.status === "saved") return "prepared" as const;
        if (saved.status !== "too_many") return "skipped" as const;
        await fail("too_many_tools");
        return "failed" as const;
      }
      await fail(outcome.reason);
      return outcome.reason === "provider_error"
        ? ("provider_error" as const)
        : ("failed" as const);
    });
    if (step === "switched_off") return { status: "stopped", prepared, failed };
    if (step === "prepared") prepared += 1;
    if (step === "failed" || step === "provider_error") failed += 1;
    // A provider failure would repeat for every tool, so the rest wait for the next run.
    if (step === "provider_error") return { status: "stopped", prepared, failed };
  }
  return { status: "prepared", prepared, failed };
}

export interface RegisterClassifierPreparationWorkersDeps extends ClassifierPreparationJobDeps {
  readonly workOptions?: WorkOptions;
}

export async function registerClassifierPreparationWorkers(
  boss: PgBoss,
  deps: RegisterClassifierPreparationWorkersDeps
): Promise<readonly string[]> {
  const workerId = await boss.work<ClassifierPreparationJobPayload>(
    INTEGRATION_CLASSIFIER_PREPARE_QUEUE,
    deps.workOptions ?? { pollingIntervalSeconds: 2 },
    async ([job]) => {
      if (!job) throw new Error("pg-boss invoked tool preparation without a job");
      const op: ClassifierPreparationJobOp = job.data.op === "retry" ? "retry" : "prepare";
      const outcome = await runClassifierPreparationJob(
        deps,
        toAccessContext(job),
        job.data.resourceId,
        op
      );
      deps.logger?.info(
        { connectionId: job.data.resourceId, op, ...outcome },
        "integrations: tool preparation finished"
      );
    }
  );
  return [workerId];
}
