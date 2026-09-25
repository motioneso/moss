/**
 * Per-user UID slot wiring for the engine host (#347, #2674). Split out of engine-host.ts to
 * keep that file under the repository file-size limit.
 */

import type { TmuxIo } from "@moss/ai";
import { deriveNeutralDir } from "@moss/chat/live";

import type { EngineHostDeps } from "./engine-host-types.js";
import { createSanitizedTmuxIo } from "./runner-io.js";
import {
  allocateUidSlot,
  migrateNeutralDir,
  pruneUidSlots,
  uidSlotOwner
} from "./uid-allocator.js";

/**
 * Allocate the launch owner's UID slot and return the owner-switched io for the session.
 * Callers hold the admission mutex, so concurrent launches cannot race on the slot file.
 */
export function perUserSessionIo(
  deps: EngineHostDeps & { readonly homeBase: string },
  key: string,
  launch: Parameters<typeof uidSlotOwner>[1]
): TmuxIo {
  const slot = allocateUidSlot(deps.homeBase, uidSlotOwner(key, launch));
  migrateNeutralDir(deriveNeutralDir(deps.neutralBase, key), slot.uid, slot.gid);
  return deps.createSlotIo ? deps.createSlotIo(slot) : createSanitizedTmuxIo(process.env, slot);
}

/** Startup prune of per-call slot entries. Never throws; logs only the error name. */
export function pruneUidSlotTable(homeBase: string | undefined): void {
  if (!homeBase) return;
  try {
    const dropped = pruneUidSlots(homeBase);
    if (dropped > 0) console.log(`[engine-host] pruned ${dropped} per-call UID slot entries`);
  } catch (err) {
    console.warn(
      `[engine-host] UID slot prune failed: ${err instanceof Error ? err.name : "UnknownError"}`
    );
  }
}
