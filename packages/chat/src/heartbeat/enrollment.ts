import type { DataContextDb, PreferencesPort } from "@moss/db";
import {
  defaultHeartbeatSources,
  PROACTIVE_MONITORING_PREFERENCE_KEY,
  type HeartbeatSettings,
  type HeartbeatSource
} from "@moss/shared";

import { HEARTBEAT_DEFAULT_CADENCE_MINUTES } from "./limits.js";
import {
  type HeartbeatSettingsRepository,
  type ReadHeartbeatSettings
} from "./settings-repository.js";

type SettingsSeed = Pick<HeartbeatSettings, "enabled" | "sources" | "origin"> & {
  /** False when a saved earlier choice exists but cannot be read. Nothing is enrolled then. */
  readonly readable: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The earlier proactive-updates source that matches each check-in source, when one exists. */
const LEGACY_SOURCE: Partial<Record<HeartbeatSource, string>> = {
  tasks: "tasks",
  calendar: "calendar",
  memory: "notes"
};

/**
 * Reads the earlier proactive-updates choice without changing it. A missing record leaves the
 * defaults in place. A saved record that cannot be read is unreadable, so checks hold until the
 * owner saves a choice; it never falls back to on.
 */
export function seedFromLegacyProactiveChoice(raw: unknown): SettingsSeed {
  const sources = defaultHeartbeatSources();
  if (raw === null || raw === undefined) {
    return { enabled: true, sources, origin: "default", readable: true };
  }
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.enabled !== "boolean") {
    return { enabled: true, sources, origin: "default", readable: false };
  }
  const legacySources = isRecord(raw.sources) ? raw.sources : {};
  for (const [source, legacyKey] of Object.entries(LEGACY_SOURCE) as [HeartbeatSource, string][]) {
    const legacy = legacySources[legacyKey];
    if (raw.enabled && isRecord(legacy) && legacy.enabled === false) {
      sources[source] = false;
    }
  }
  if (!raw.enabled) return { enabled: false, sources, origin: "legacy_off", readable: true };
  return { enabled: true, sources, origin: "default", readable: true };
}

export async function readLegacySeed(
  scopedDb: DataContextDb,
  preferences: PreferencesPort
): Promise<SettingsSeed> {
  return seedFromLegacyProactiveChoice(
    await preferences.get(scopedDb, PROACTIVE_MONITORING_PREFERENCE_KEY)
  );
}

/** Creates the owner's settings record on first contact, honouring a saved earlier opt-out. */
export async function enrollOwner(
  scopedDb: DataContextDb,
  deps: { readonly settings: HeartbeatSettingsRepository; readonly preferences: PreferencesPort }
): Promise<ReadHeartbeatSettings> {
  const existing = await deps.settings.find(scopedDb);
  if (existing) return existing;
  const seed = await readLegacySeed(scopedDb, deps.preferences);
  if (!seed.readable) return unstoredRecord(seed);
  return deps.settings.enroll(scopedDb, seed);
}

/** A record that is shown but not stored. Unreadable seeds stay on hold. */
function unstoredRecord(seed: SettingsSeed): ReadHeartbeatSettings {
  return {
    settings: {
      enabled: seed.enabled,
      cadenceMinutes: HEARTBEAT_DEFAULT_CADENCE_MINUTES,
      sources: seed.sources,
      revision: 0,
      origin: seed.origin
    },
    readable: seed.readable,
    nextDueAt: null
  };
}

/**
 * What Settings shows before any record exists: the defaults, or the saved earlier opt-out.
 * Read-only, so opening Settings never writes.
 */
export async function resolveHeartbeatSettings(
  scopedDb: DataContextDb,
  deps: { readonly settings: HeartbeatSettingsRepository; readonly preferences: PreferencesPort }
): Promise<ReadHeartbeatSettings> {
  const existing = await deps.settings.find(scopedDb);
  if (existing) return existing;
  return unstoredRecord(await readLegacySeed(scopedDb, deps.preferences));
}
