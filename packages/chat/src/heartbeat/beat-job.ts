import type { PgBoss } from "pg-boss";

import type { DataContextDb, DataContextRunner, PreferencesPort } from "@moss/db";
import {
  registerDataContextWorker,
  type ActorScopedJobPayload,
  type QueueDefinition
} from "@moss/jobs";

import { HEARTBEAT_SOURCES, LOCALE_PREFERENCE_KEY, resolveEffectiveLocale } from "@moss/shared";

import { ChatRepository } from "../repository.js";
import { reserveAttempt } from "./allowance.js";
import { boundCandidates, type HeartbeatGenerator } from "./generation.js";
import { collectSources, toCandidates, type HeartbeatGateway } from "./collect.js";
import { filterCandidates, isMuted } from "./filter.js";
import { HEARTBEAT_GENERATION_TIMEOUT_MS } from "./limits.js";
import { changedSources } from "./precheck.js";
import { publishHeartbeat } from "./publish.js";
import { loadCheckpoints, loadMuteRules, loadSettledKeys, saveCheckpoint } from "./store.js";
import { validateHeartbeatResult } from "./validator.js";
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
  /** Without the next three the beat only enrolls and records a quiet check. */
  readonly gateway?: HeartbeatGateway;
  readonly generate?: HeartbeatGenerator;
  readonly boss?: Pick<PgBoss, "send">;
  readonly chat?: ChatRepository;
  readonly now?: () => Date;
}

function localClock(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    dateStyle: "full",
    timeStyle: "short"
  }).format(now);
}

/**
 * One check for one owner: read the enabled sources, skip the model when nothing moved, and
 * otherwise ask it which items deserve attention. Every outcome is recorded; the model never
 * writes titles or times, and a failed or rejected answer publishes nothing.
 */
export async function handleHeartbeatBeat(
  scopedDb: DataContextDb,
  payload: HeartbeatBeatPayload,
  deps: HeartbeatBeatDeps
): Promise<HeartbeatBeatResult> {
  const settings = deps.settings ?? new HeartbeatSettingsRepository();
  const occurrences = deps.occurrences ?? new HeartbeatOccurrenceRepository();

  const before = await settings.find(scopedDb);
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
  const advance = () =>
    settings.advance(scopedDb, stored.settings.revision, stored.settings.cadenceMinutes);

  if (!deps.gateway || !deps.generate || !deps.boss) {
    await occurrences.finish(scopedDb, { id: payload.resourceId, outcome: "quiet" });
    await advance();
    return "checked";
  }

  const now = (deps.now ?? (() => new Date()))();
  const enabledSources = HEARTBEAT_SOURCES.filter((source) => stored.settings.sources[source]);
  const { reads, unavailable } = await collectSources(
    deps.gateway,
    payload.actorUserId,
    enabledSources,
    payload.resourceId
  );
  const checkpoints = await loadCheckpoints(scopedDb);
  const changed = new Set(changedSources(reads, checkpoints, now));
  const changedReads = reads.filter((read) => changed.has(read.source));
  const advanceCheckpoints = async () => {
    for (const read of changedReads) {
      await saveCheckpoint(scopedDb, {
        source: read.source,
        revision: read.revision,
        nextBoundaryAt: read.nextBoundaryAt,
        now
      });
    }
  };
  const quiet = async () => {
    await advanceCheckpoints();
    await occurrences.finish(scopedDb, {
      id: payload.resourceId,
      outcome: unavailable.length > 0 ? "degraded" : "quiet",
      unavailableSources: unavailable
    });
    await advance();
    return "checked" as const;
  };

  const candidates = boundCandidates(
    filterCandidates(
      toCandidates(changedReads),
      await loadMuteRules(scopedDb),
      await loadSettledKeys(scopedDb, [...changed])
    )
  );
  if (candidates.length === 0) return quiet();

  const timeZone = resolveEffectiveLocale(
    await deps.preferences.get(scopedDb, LOCALE_PREFERENCE_KEY)
  ).timezone;
  const reservation = await reserveAttempt(scopedDb, {
    occurrenceId: payload.resourceId,
    now,
    timeZone
  });
  if (!reservation) {
    await occurrences.finish(scopedDb, {
      id: payload.resourceId,
      outcome: "held_allowance",
      unavailableSources: unavailable
    });
    await advance();
    return "checked";
  }

  const failed = async (usage?: { inputTokens: number; outputTokens: number }) => {
    await occurrences.finish(scopedDb, {
      id: payload.resourceId,
      outcome: "failed",
      unavailableSources: unavailable,
      inputTokens: usage?.inputTokens,
      outputTokens: usage?.outputTokens
    });
    await advance();
    return "checked" as const;
  };
  const generated = await deps.generate(
    payload.actorUserId,
    { candidates, localTime: localClock(now, timeZone) },
    AbortSignal.timeout(HEARTBEAT_GENERATION_TIMEOUT_MS)
  );
  if (!generated.ok) return failed();
  const validated = validateHeartbeatResult(generated.object, candidates);
  if (!validated.ok) return failed(generated.usage);

  // Re-read what may have changed while the model ran: the saved choices and the mutes.
  const current = await settings.find(scopedDb, { forUpdate: true });
  if (!current?.settings.enabled || current.settings.revision !== stored.settings.revision) {
    await occurrences.finish(scopedDb, { id: payload.resourceId, outcome: "quiet" });
    return "stale";
  }
  const mutes = await loadMuteRules(scopedDb);
  const byId = new Map(candidates.map((candidate) => [candidate.findingId, candidate]));
  const selected = validated.result.selected.filter((entry) => {
    const candidate = byId.get(entry.findingId);
    return candidate !== undefined && !isMuted(mutes, candidate.source, candidate.item);
  });
  if (selected.length === 0) {
    await advanceCheckpoints();
    await occurrences.finish(scopedDb, {
      id: payload.resourceId,
      outcome: unavailable.length > 0 ? "degraded" : "quiet",
      unavailableSources: unavailable,
      inputTokens: generated.usage.inputTokens,
      outputTokens: generated.usage.outputTokens
    });
    await advance();
    return "checked";
  }

  const published = await publishHeartbeat(
    scopedDb,
    { chat: deps.chat ?? new ChatRepository(), boss: deps.boss },
    {
      actorUserId: payload.actorUserId,
      occurrenceId: payload.resourceId,
      settingsRevision: stored.settings.revision,
      candidates,
      result: { selected, intro: validated.result.intro },
      now
    }
  );
  await advanceCheckpoints();
  await occurrences.finish(scopedDb, {
    id: payload.resourceId,
    outcome: "message",
    itemCount: published.itemCount,
    messageId: published.messageId,
    unavailableSources: unavailable,
    inputTokens: generated.usage.inputTokens,
    outputTokens: generated.usage.outputTokens
  });
  await advance();
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
