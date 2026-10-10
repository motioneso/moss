import type { DataContextDb } from "@moss/db";
import type { ProactiveMonitorProvider } from "@moss/module-sdk";
import {
  rankPriorityCandidates,
  type PriorityCandidate,
  type PriorityPreferencesRepository,
  type PrioritySource
} from "@moss/priority";
import { defaultProactiveMonitoringPreference, type ProactiveSource } from "@moss/shared";

import type { AntiSpamPolicy } from "./anti-spam.js";
import type { CardRepository } from "./card-repository.js";
import type { MonitorStateRepository } from "./monitor-state-repository.js";
import type { ProactiveMonitoringPreferencesRepository } from "./preferences-repository.js";
import { isProactiveSourceEnabled } from "./preferences-repository.js";
import { isAllowedSignalType, mapSignalType } from "./signal-mapper.js";
import type { ProactiveQuietPolicy, ResolvedMonitoringConfig } from "./types.js";

const SCAN_COOLDOWN_MS = 15 * 60 * 1000;
const MAX_SIGNALS = 20;

interface ScanDependencies {
  readonly preferencesRepository: ProactiveMonitoringPreferencesRepository;
  readonly priorityPreferencesRepository: PriorityPreferencesRepository;
  readonly monitorStateRepository: MonitorStateRepository;
  readonly cardRepository: CardRepository;
  readonly antiSpamPolicy: AntiSpamPolicy;
  readonly getLocalePreference: (scopedDb: DataContextDb) => Promise<{ timezone?: string } | null>;

  /** The owner's saved quiet-hours schedule; null keeps the nested alert schedule. */
  readonly resolveQuietHours: (scopedDb: DataContextDb) => Promise<ProactiveQuietPolicy | null>;
}

export type ScanReason = "source-sync" | "manual-refresh" | "scheduled-check";

export interface ScanResult {
  readonly source: ProactiveSource;
  readonly signalsReceived: number;
  readonly cardsCreated: number;
  readonly cardsUpdated: number;
  readonly cardsDeferred: number;
  readonly cardsSuppressed: number;
  readonly skipped: boolean;
  readonly skipReason?: string;
}

export class ProactiveScanner {
  constructor(private readonly deps: ScanDependencies) {}

  async scan(
    scopedDb: DataContextDb,
    ownerUserId: string,
    source: ProactiveSource,
    provider: ProactiveMonitorProvider,
    reason: ScanReason,
    now: Date = new Date()
  ): Promise<ScanResult> {
    const nowIso = now.toISOString();

    // Load monitoring preference.
    const saved = await this.deps.preferencesRepository.getSaved(scopedDb);
    const pref = saved?.preference ?? defaultProactiveMonitoringPreference();
    if (source !== "email" && !pref.enabled) {
      return skip(source, "monitoring_disabled");
    }
    if (!isProactiveSourceEnabled(pref, source, saved)) {
      return skip(source, "source_disabled");
    }

    // Source cooldown: skip if checked within 15 min (unless source-sync trigger).
    if (reason !== "source-sync") {
      const state = await this.deps.monitorStateRepository.get(scopedDb, ownerUserId, source);
      if (state?.last_checked_at) {
        const elapsed = now.getTime() - new Date(state.last_checked_at).getTime();
        if (elapsed < SCAN_COOLDOWN_MS) {
          return skip(source, "cooldown");
        }
      }
    }

    // Resolve timezone.
    const localePref = await this.deps.getLocalePreference(scopedDb);
    const timeZone =
      typeof localePref?.timezone === "string" && localePref.timezone ? localePref.timezone : "UTC";
    const quiet = await this.deps.resolveQuietHours(scopedDb);

    // Load priority anchors for provider input.
    const priorityRawPref = await scopedDb.db
      .selectFrom("app.preferences")
      .select("value_json")
      .where("key", "=", "priority.model.v1")
      .executeTakeFirst();
    const priorityModel = this.deps.priorityPreferencesRepository.get(priorityRawPref?.value_json);
    const priorityAnchors = priorityModel.anchors
      .filter((a) => a.enabled)
      .map((a) => ({ label: a.label, aliases: a.aliases }));

    // Load current cursor.
    const state = await this.deps.monitorStateRepository.get(scopedDb, ownerUserId, source);
    const sinceCursor = state?.cursor_json ?? {};

    // Call provider.
    let providerResult;
    try {
      providerResult = await provider.collectSignals(scopedDb, {
        ownerUserId,
        sinceCursor,
        now: nowIso,
        timeZone,
        maxSignals: MAX_SIGNALS,
        priorityAnchors
      });
    } catch (err) {
      const errorClass = err instanceof Error ? err.constructor.name : "UnknownError";
      await this.deps.monitorStateRepository.recordFailure(
        scopedDb,
        ownerUserId,
        source,
        errorClass
      );
      return skip(source, "provider_error");
    }

    const { signals, nextCursor } = providerResult;
    let cardsCreated = 0;
    let cardsUpdated = 0;
    let cardsDeferred = 0;
    let cardsSuppressed = 0;

    // Filter to allowed signal types, map to priority candidates, rank.
    const allowedSignals = signals.filter((s) => isAllowedSignalType(source, s.signalType));
    // Match each ranked result back to its exact signal by the candidate key (#2609). Titles
    // are not unique — recurring events and repeated subjects share them — so matching by
    // title can put one signal's card on another's details once ranking reorders them.
    // The key is the signal's position here, which no ranking order can disturb.
    const signalByKey = new Map(allowedSignals.map((s, index) => [String(index), s]));
    const candidates: PriorityCandidate[] = allowedSignals.map((s, index) => {
      const pc = s.priorityCandidate as Record<string, unknown>;
      return {
        source: source as PrioritySource,
        title: s.title,
        summary: s.summary,
        signalType: mapSignalType(s.signalType),
        occurredAt: s.occurredAt,
        textForAnchorMatch: [s.title, s.summary],
        ...(pc ?? {}),
        key: String(index)
      } as PriorityCandidate;
    });

    let ranked;
    try {
      ranked = rankPriorityCandidates({
        model: priorityModel,
        candidates,
        now: nowIso,
        timeZone,
        focusReadiness: []
      });
    } catch {
      await this.deps.monitorStateRepository.advanceCursor(
        scopedDb,
        ownerUserId,
        source,
        nextCursor as Record<string, unknown>
      );
      return skip(source, "scorer_error");
    }

    // ranked is already sorted by score descending (not in input order). Each result
    // carries its candidate's key, so same-title results still reach their own signal.
    for (const result of ranked) {
      if (result.band !== "critical" && result.band !== "high") continue;

      const signal = result.key === undefined ? undefined : signalByKey.get(result.key);
      if (!signal) continue;

      const verdict = await this.deps.antiSpamPolicy.check(
        scopedDb,
        ownerUserId,
        source,
        signal.stableKey,
        pref,
        nowIso,
        timeZone,
        quiet
      );

      if (!verdict.allow) {
        cardsSuppressed++;
        continue;
      }

      const existing = await this.deps.cardRepository.findByStableKey(
        scopedDb,
        ownerUserId,
        source,
        signal.stableKey
      );

      await this.deps.cardRepository.upsertCard(scopedDb, {
        ownerUserId,
        source,
        stableKey: signal.stableKey,
        sourceRefHash: signal.sourceRefHash,
        title: signal.title,
        summary: signal.summary,
        signalType: signal.signalType,
        priorityBand: result.band,
        priorityReasons: result.reasons,
        occurredAt: signal.occurredAt ?? null,
        targetAt: signal.targetAt ?? null,
        expiresAt: signal.expiresAt ?? null,
        deferredUntil: verdict.deferredUntil ?? null,
        metadata: { providerVersion: 1 }
      });

      if (verdict.deferredUntil) {
        cardsDeferred++;
      } else if (existing) {
        cardsUpdated++;
      } else {
        cardsCreated++;
      }
    }

    // Advance cursor only on success.
    await this.deps.monitorStateRepository.advanceCursor(
      scopedDb,
      ownerUserId,
      source,
      nextCursor as Record<string, unknown>
    );

    return {
      source,
      signalsReceived: signals.length,
      cardsCreated,
      cardsUpdated,
      cardsDeferred,
      cardsSuppressed,
      skipped: false
    };
  }
}

function skip(source: ProactiveSource, reason: string): ScanResult {
  return {
    source,
    signalsReceived: 0,
    cardsCreated: 0,
    cardsUpdated: 0,
    cardsDeferred: 0,
    cardsSuppressed: 0,
    skipped: true,
    skipReason: reason
  };
}

export async function resolveMonitoringConfig(
  scopedDb: DataContextDb,
  prefsRepo: ProactiveMonitoringPreferencesRepository,
  priorityPrefsRepo: PriorityPreferencesRepository,
  getLocale: (db: DataContextDb) => Promise<{ timezone?: string } | null>
): Promise<ResolvedMonitoringConfig> {
  const preference = await prefsRepo.get(scopedDb);
  const localePref = await getLocale(scopedDb);
  const timeZone =
    typeof localePref?.timezone === "string" && localePref.timezone ? localePref.timezone : "UTC";
  const priorityRaw = await scopedDb.db
    .selectFrom("app.preferences")
    .select("value_json")
    .where("key", "=", "priority.model.v1")
    .executeTakeFirst();
  const priorityModel = priorityPrefsRepo.get(priorityRaw?.value_json);
  const priorityAnchors = priorityModel.anchors
    .filter((a) => a.enabled)
    .map((a) => ({ label: a.label, aliases: a.aliases }));
  return { preference, timeZone, priorityAnchors };
}
