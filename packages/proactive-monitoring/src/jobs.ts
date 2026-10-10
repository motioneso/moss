import type { PgBoss } from "pg-boss";

import type { DataContextRunner } from "@moss/db";
import {
  assertMetadataOnlyPayload,
  registerDataContextWorker,
  sendJob,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import { PriorityPreferencesRepository } from "@moss/priority";
import type { ProactiveSource } from "@moss/shared";

import { AntiSpamPolicy } from "./anti-spam.js";
import { CardRepository } from "./card-repository.js";
import { MonitorStateRepository } from "./monitor-state-repository.js";
import { ProactiveMonitoringPreferencesRepository } from "./preferences-repository.js";
import { ProactiveScanner } from "./scanner.js";
import type { ProactiveQuietPolicy } from "./types.js";

/** Metadata-only — no private content, prompts, or connector payloads. */
export interface ProactiveScanSourceJobPayload extends ActorScopedJobPayload {
  readonly source: ProactiveSource;
  readonly reason: "source-sync" | "manual-refresh" | "scheduled-check";
  readonly idempotencyKey: string;
}

export const PROACTIVE_SCAN_SOURCE_QUEUE: QueueDefinition = {
  name: "proactive-scan-source",
  options: {
    retryLimit: 2,
    retryDelay: 60,
    expireInSeconds: 300
  }
};

interface WorkerDependencies {
  readonly dataContext: DataContextRunner;
  readonly getLocalePreference: (
    scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]
  ) => Promise<{ timezone?: string } | null>;
  readonly resolveQuietHours: (
    scopedDb: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]
  ) => Promise<ProactiveQuietPolicy | null>;
  readonly providers: ReadonlyMap<ProactiveSource, ProactiveMonitorProvider>;
}

export async function registerProactiveMonitoringWorkers(
  boss: PgBoss,
  deps: WorkerDependencies
): Promise<string[]> {
  const cardRepository = new CardRepository();
  const prefsRepo = new ProactiveMonitoringPreferencesRepository();
  const priorityPrefsRepo = new PriorityPreferencesRepository();
  const monitorStateRepo = new MonitorStateRepository();
  const antiSpam = new AntiSpamPolicy(cardRepository);

  const scanner = new ProactiveScanner({
    preferencesRepository: prefsRepo,
    priorityPreferencesRepository: priorityPrefsRepo,
    monitorStateRepository: monitorStateRepo,
    cardRepository,
    antiSpamPolicy: antiSpam,
    getLocalePreference: deps.getLocalePreference,
    resolveQuietHours: deps.resolveQuietHours
  });

  const workerId = await registerDataContextWorker<ProactiveScanSourceJobPayload, void>(
    boss,
    PROACTIVE_SCAN_SOURCE_QUEUE.name,
    deps.dataContext,
    async (job, scopedDb) => {
      assertMetadataOnlyPayload(job.data);
      const { source, reason, actorUserId } = job.data;
      const provider = deps.providers.get(source);
      if (!provider) return;
      await scanner.scan(scopedDb, actorUserId, source, provider, reason);
    }
  );

  return [workerId];
}

export async function enqueueProactiveScan(
  boss: PgBoss,
  actorUserId: string,
  source: ProactiveSource,
  reason: ProactiveScanSourceJobPayload["reason"],
  idempotencyKey: string
): Promise<void> {
  const payload: ProactiveScanSourceJobPayload = {
    actorUserId,
    source,
    reason,
    idempotencyKey
  };
  assertMetadataOnlyPayload(payload);
  await sendJob(boss, PROACTIVE_SCAN_SOURCE_QUEUE.name, payload, { singletonKey: idempotencyKey });
}
