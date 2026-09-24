import { randomUUID } from "node:crypto";

import type { FastifyBaseLogger } from "fastify";
import type { Job, PgBoss, WorkOptions } from "pg-boss";

import { AiRepository, createAiSecretCipher } from "@moss/ai";
import type { DataContextDb, DataContextRunner } from "@moss/db";
import {
  registerDataContextWorker,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";
import type { RetrievedChunk } from "@moss/memory";
import type { MossModuleManifest } from "@moss/module-sdk";
import type { NotificationsRepository } from "@moss/notifications";
import type { BriefingRunKind, BriefingType } from "@moss/shared";

import type { ComposeDeps } from "./compose.js";
import type { BriefingDayPlanAutoPort } from "./repository.js";
import { BRIEFINGS_MODULE_ID, BRIEFINGS_RUN_QUEUE } from "./manifest.js";
import { BriefingsRepository } from "./repository.js";
import { withToolSavepoint } from "./savepoint.js";

export interface BriefingRunPayload extends ActorScopedJobPayload {
  readonly definitionId: string;
  // Optional: a scheduled cron fire carries no run id (the schedule payload is pure
  // metadata — {actorUserId, definitionId, runKind}); the worker mints one at fire
  // time. Manual run-now jobs always carry one from the route.
  readonly briefingRunId?: string;
  readonly runKind: BriefingRunKind;
  readonly briefingType: BriefingType;
  readonly idempotencyKey?: string;
}

export interface BriefingRunResult {
  readonly definitionId: string;
  readonly runId: string;
  readonly status: "succeeded" | "blocked" | "failed" | null;
  readonly created: boolean;
  // Present when generation reserved an apply batch that still needs the
  // apply job (fresh auto runs and resumed duplicates).
  readonly auto?: {
    readonly planId: string;
    readonly operationId: string;
    readonly batchKey: string;
  } | null;
}

// Metadata-only apply dispatch for one reserved automatic batch (R2.3-T06).
// Any other key is rejected by the calendar worker exactly as briefing
// payloads are rejected here.
export interface DayPlanApplyDispatchPayload {
  readonly actorUserId: string;
  readonly planId: string;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly briefingRunId: string;
}

export const DAY_PLAN_APPLY_DISPATCH_PAYLOAD_KEYS = [
  "actorUserId",
  "planId",
  "operationId",
  "idempotencyKey",
  "briefingRunId"
] as const;

export interface RegisterBriefingsJobWorkersOptions {
  readonly moduleManifests: readonly MossModuleManifest[];
  /**
   * Synthesis dependencies forwarded to `generateRun`. When omitted, a metadata-only
   * `composeDeps` is built from `moduleManifests` so the worker still gathers sections
   * and takes the deterministic degraded fallback (no provider configured → no_model).
   * A8 injects the full AI/cipher/memory/notification deps from the module registry.
   */
  readonly composeDeps?: ComposeDeps;
  /**
   * Used to deliver the "Your morning briefing is ready" notification on a NEWLY-created
   * scheduled run that succeeded. A8 injects the registry-built repository; tests inject
   * a real one bound to the worker data context. The notification is metadata-only
   * ({definitionId, briefingRunId}) and is fired inside the owner's RLS context, so the
   * worker can only deliver it to the owner (worker INSERT policy mirrors app's
   * recipient-only WITH CHECK — migration 0071).
   */
  readonly notificationsRepository?: NotificationsRepository;
  readonly repository?: BriefingsRepository;
  /**
   * Automatic plan-effect port (R2.3-T06): reserves day-plan blocks and the
   * apply batch inside the generation transaction. Absent in tests that do
   * not exercise the automatic path.
   */
  readonly dayPlanAuto?: BriefingDayPlanAutoPort;
  /**
   * Sends one reserved automatic batch to the apply queue. Injected by the
   * composition root (the calendar queue lives in another module); tests
   * inject a fake. Called only from the after-commit hook, never from inside
   * the handler transaction.
   */
  readonly dispatchDayPlanApply?: (payload: DayPlanApplyDispatchPayload) => Promise<unknown>;
  readonly workOptions?: WorkOptions;
  readonly onResult?: (job: Job<BriefingRunPayload>, result: BriefingRunResult) => void;
  /**
   * Structured logger for worker-path diagnostics (briefing_notification_failed,
   * etc.). Optional for back-compat; production injects a module-tagged child of
   * server.log / the worker logger (observability spec: no console.* in prod).
   */
  readonly logger?: FastifyBaseLogger;
}

export const BRIEFINGS_QUEUE_DEFINITIONS: readonly QueueDefinition[] = [
  {
    name: BRIEFINGS_RUN_QUEUE,
    options: {
      // `exclusive`: at most one job per (queue, singletonKey) across all
      // non-terminal states (created OR active). This is what makes a
      // client-supplied idempotency key actually dedupe a run-now submit (#150) —
      // a double-click / retry while the first run is still queued or running is
      // collapsed to a single job. The route namespaces the singletonKey by
      // definition id (and uses a unique key for keyless runs so they never
      // falsely collide). Standard policy stores singletonKey but never dedupes.
      policy: "exclusive",
      retryLimit: 0,
      deleteAfterSeconds: 60,
      retentionSeconds: 60
    }
  }
];

export const BRIEFING_RUN_PAYLOAD_KEYS = [
  "actorUserId",
  "definitionId",
  "briefingRunId",
  "runKind",
  "briefingType",
  "idempotencyKey"
] as const;

export function isBriefingRunPayloadMetadataOnly(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return false;
  }
  const allowedKeys = new Set<string>(BRIEFING_RUN_PAYLOAD_KEYS);

  return Object.keys(payload).every((key) => allowedKeys.has(key));
}

/**
 * A vault retriever that returns nothing. Used as the default when no `composeDeps`
 * is injected (A8 injects the registry-built `MemoryRetriever`). Keeping the default
 * inert avoids pulling embedding-model init into the worker before A8 wires the real
 * retriever — compose just records an `empty` vault gap, which is correct here.
 */
const noopMemoryRetriever = {
  async retrieve(_scopedDb: DataContextDb, _query: string): Promise<RetrievedChunk[]> {
    return [];
  },
  async retrieveRecent(_scopedDb: DataContextDb): Promise<RetrievedChunk[]> {
    return [];
  }
} as ComposeDeps["memoryRetriever"];

function defaultComposeDeps(moduleManifests: readonly MossModuleManifest[]): ComposeDeps {
  return {
    moduleManifests,
    aiRepository: new AiRepository(),
    cipher: createAiSecretCipher(),
    memoryRetriever: noopMemoryRetriever
  };
}

export async function registerBriefingsJobWorkers(
  boss: PgBoss,
  dataContext: DataContextRunner,
  options: RegisterBriefingsJobWorkersOptions
): Promise<string[]> {
  const repository = options.repository ?? new BriefingsRepository();
  const composeDeps = options.composeDeps ?? defaultComposeDeps(options.moduleManifests);
  const workId = await registerDataContextWorker<BriefingRunPayload, BriefingRunResult>(
    boss,
    BRIEFINGS_RUN_QUEUE,
    dataContext,
    async (job, scopedDb) => {
      if (!isBriefingRunPayloadMetadataOnly(job.data)) {
        throw new Error(`Briefing job ${job.id} contains non-metadata payload fields`);
      }

      // Normalize the optional scheduled payload to a guaranteed run id before calling
      // the repository: scheduled cron data carries no briefingRunId, so mint one here at
      // the handler boundary. Manual runs always carry one from the route.
      const briefingRunId = job.data.briefingRunId ?? randomUUID();

      const outcome = await repository.generateRun(scopedDb, job.data.definitionId, {
        moduleManifests: options.moduleManifests,
        runKind: job.data.runKind,
        runId: briefingRunId,
        jobId: job.id,
        composeDeps,
        ...(options.dayPlanAuto ? { dayPlanAuto: options.dayPlanAuto } : {})
      });

      // Notify ONLY for a NEWLY-created scheduled run that succeeded: an idempotent
      // same-local-day skip returns created:false and must not re-notify. Degraded runs
      // are status "succeeded" + a source_metadata flag, so this covers them too. The
      // notification is metadata-only (no briefing content) and best-effort: a delivery
      // failure is logged (name+message) and never fails the run.
      if (
        options.notificationsRepository &&
        outcome?.created &&
        job.data.runKind === "scheduled" &&
        outcome.run.status === "succeeded"
      ) {
        const notifications = options.notificationsRepository;
        try {
          // The savepoint keeps a failed notification write from rolling back the saved run.
          await withToolSavepoint(scopedDb, () =>
            notifications.create(scopedDb, {
              moduleId: BRIEFINGS_MODULE_ID,
              title:
                outcome.run.briefing_type === "evening"
                  ? "Your evening review is ready"
                  : outcome.run.briefing_type === "weekly_review"
                    ? "Your weekly review is ready"
                    : "Your morning briefing is ready",
              urgency: "normal",
              metadata: { definitionId: outcome.run.definition_id, briefingRunId: outcome.run.id }
            })
          );
        } catch (error) {
          const e = error instanceof Error ? error : new Error(String(error));
          options.logger?.error(
            {
              event: "briefing_notification_failed",
              definitionId: outcome.run.definition_id,
              error: e.name,
              message: e.message.slice(0, 200)
            },
            "briefing notification write failed"
          );
        }
      }

      // `auto` stays absent unless a batch was reserved: existing exact-shape
      // assertions on the worker result keep passing untouched.
      const result: BriefingRunResult = {
        definitionId: job.data.definitionId,
        runId: outcome?.run.id ?? briefingRunId,
        status: outcome?.run.status ?? null,
        created: outcome?.created ?? false,
        ...(outcome?.auto ? { auto: outcome.auto } : {})
      };

      options.onResult?.(job, result);

      return result;
    },
    options.workOptions,
    {
      // Dispatch only after the generation transaction committed: the batch
      // is durable before the apply job can observe it. A throw here fails
      // the briefing job without rolling back the committed run, and the
      // retry resumes the same batch by key instead of composing again.
      afterCommit: async (result, job) => {
        if (!result.auto) return;
        if (!options.dispatchDayPlanApply) {
          throw new Error(
            `Briefing run ${result.runId} reserved an apply batch with no apply dispatcher`
          );
        }
        await options.dispatchDayPlanApply({
          actorUserId: job.data.actorUserId,
          planId: result.auto.planId,
          operationId: result.auto.operationId,
          idempotencyKey: result.auto.batchKey,
          briefingRunId: result.runId
        });
      }
    }
  );

  return [workId];
}
