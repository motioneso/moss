import type { PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";
import {
  registerDataContextWorker,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";

import { enrollOwner } from "./enrollment.js";
import { HeartbeatSettingsRepository } from "./settings-repository.js";
import { HeartbeatOccurrenceRepository } from "./status-repository.js";

export const CHAT_HEARTBEAT_BEAT_QUEUE = "chat.heartbeat-beat";

export const CHAT_HEARTBEAT_BEAT_QUEUE_DEFINITION: QueueDefinition = {
  name: CHAT_HEARTBEAT_BEAT_QUEUE,
  options: {
    // One pending or running beat per owner; the sweep's singleton key collapses repeats.
    policy: "exclusive",
    retryLimit: 1,
    retryDelay: 30,
    expireInSeconds: 300,
    deleteAfterSeconds: 600,
    retentionSeconds: 3_600
  }
};

/** Metadata only. `resourceId` is the occurrence ID and `version` the settings revision seen. */
export interface HeartbeatBeatPayload extends ActorScopedJobPayload {
  readonly kind: "heartbeat-beat";
  readonly resourceId: string;
  readonly version: number;
  readonly idempotencyKey: string;
}

export type HeartbeatBeatResult = "checked" | "off" | "stale" | "not_due" | "duplicate" | "on_hold";

export interface HeartbeatBeatDeps {
  readonly preferences: PreferencesPort;
  readonly settings?: HeartbeatSettingsRepository;
  readonly occurrences?: HeartbeatOccurrenceRepository;
}

/**
 * One check for one owner. This slice enrolls the owner and records an inspectable quiet
 * outcome. It reads no sources and calls no model.
 */
export async function handleHeartbeatBeat(
  scopedDb: DataContextDb,
  payload: HeartbeatBeatPayload,
  deps: HeartbeatBeatDeps
): Promise<HeartbeatBeatResult> {
  const settings = deps.settings ?? new HeartbeatSettingsRepository();
  const occurrences = deps.occurrences ?? new HeartbeatOccurrenceRepository();

  const before = await settings.find(scopedDb, { forUpdate: true });
  if (before && before.settings.revision !== payload.version) return "stale";
  const stored =
    before ?? (await enrollOwner(scopedDb, { settings, preferences: deps.preferences }));

  if (!stored.settings.enabled) {
    await settings.clearSchedule(scopedDb);
    return "off";
  }
  if (!stored.readable) {
    await settings.advance(scopedDb, stored.settings.revision, stored.settings.cadenceMinutes);
    return "on_hold";
  }
  if (stored.nextDueAt && stored.nextDueAt.getTime() > Date.now()) return "not_due";
  if (await occurrences.hasOccurrence(scopedDb, payload.resourceId)) return "duplicate";

  await occurrences.start(scopedDb, {
    id: payload.resourceId,
    settingsRevision: stored.settings.revision
  });
  await occurrences.finish(scopedDb, { id: payload.resourceId, outcome: "quiet" });
  await settings.advance(scopedDb, stored.settings.revision, stored.settings.cadenceMinutes);
  return "checked";
}

export function registerHeartbeatBeatWorker(
  boss: PgBoss,
  dataContext: DataContextRunner,
  deps: HeartbeatBeatDeps,
  workOptions?: Parameters<typeof registerDataContextWorker>[4]
): Promise<string> {
  return registerDataContextWorker<HeartbeatBeatPayload, HeartbeatBeatResult>(
    boss,
    CHAT_HEARTBEAT_BEAT_QUEUE,
    dataContext,
    (job, scopedDb) => handleHeartbeatBeat(scopedDb, job.data, deps),
    workOptions
  );
}
