/**
 * Per-user UID slot wiring for the engine host (#347, #2674). Split out of engine-host.ts to
 * keep that file under the repository file-size limit.
 */

import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { transcriptGlobDir, type TmuxIo } from "@moss/ai";
import { deriveNeutralDir } from "@moss/chat/live";

import type { EngineHostDeps } from "./engine-host-types.js";
import type { purgeOwnedPath } from "./owned-fs.js";
import { removeOwnedFolder } from "./per-user-structured.js";
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

const SLOT_UID_MIN = 100_001;
const SLOT_UID_MAX = 101_000;

/**
 * Startup removal of structured-call working folders a UID slot still owns. The runner cannot look
 * inside them, so the private-transcript sweep would fail on each one and hold back the slot prune
 * forever. Structured calls run only the Claude print engine, which leaves no marker files, so the
 * sweep loses nothing: the call's transcript in the shared home is removed here by path instead.
 */
export async function clearOwnedStructuredFolders(deps: {
  readonly neutralBase: string;
  readonly homeBase?: string;
  readonly purgeOwnedPath?: typeof purgeOwnedPath;
}): Promise<void> {
  const { neutralBase, homeBase, purgeOwnedPath: purge } = deps;
  const names = await readdir(neutralBase).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith("structured-")) continue;
    const path = join(neutralBase, name);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isDirectory() || stat.uid < SLOT_UID_MIN || stat.uid > SLOT_UID_MAX) continue;
    await rm(transcriptGlobDir("anthropic", path, homeBase), {
      recursive: true,
      force: true
    }).catch(() => undefined);
    await removeOwnedFolder(path, { uid: stat.uid, gid: stat.gid }, purge).catch(() => undefined);
  }
}
