/**
 * Per-user UID/GID slot allocator for the cli-runner (#347).
 *
 * Maps each actorUserId to a stable OS UID + GID slot so every user's CLI subprocess
 * runs under a distinct identity. Slot assignments are persisted to a JSON file on the
 * auth volume so they survive container restarts.
 *
 * All I/O here is synchronous — this runs once per session start on a local volume,
 * not on a hot message path. Atomic writes (tmp → rename) prevent partial-write
 * corruption on the slot file.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const UID_BASE = 100_000;
const GID_BASE = 100_000;
const MAX_SLOTS = 1_000;

const SLOT_FILE = "uid-slots.json";

interface UidSlot {
  uid: number;
  gid: number;
}

/**
 * Return the stable UID/GID for `actorUserId`, allocating a new slot if needed.
 * Slot file lives at `path.join(homeBase, "uid-slots.json")`.
 * Throws if MAX_SLOTS would be exceeded.
 */
export function allocateUidSlot(homeBase: string, actorUserId: string): UidSlot {
  const slotFilePath = path.join(homeBase, SLOT_FILE);
  const slots = readSlots(slotFilePath);

  if (actorUserId in slots) {
    const slot = slots[actorUserId] as number;
    return { uid: UID_BASE + slot, gid: GID_BASE + slot };
  }

  // Lowest free number. Slot 0 is reserved as sentinel; real slots start at 1. Holes only
  // appear after `pruneUidSlots`, which runs once the startup sweep has cleared every file a
  // pruned slot could still own.
  const taken = new Set(Object.values(slots));
  let nextSlot = 1;
  while (taken.has(nextSlot)) nextSlot += 1;
  if (nextSlot > MAX_SLOTS) {
    throw new Error("[cli-runner] UID slot overflow: maximum user slots exhausted");
  }

  slots[actorUserId] = nextSlot;
  writeSlots(slotFilePath, slots);

  return { uid: UID_BASE + nextSlot, gid: GID_BASE + nextSlot };
}

/**
 * Keys minted fresh for one throwaway launch. Before #2674 the engine host keyed slots by
 * session key, so each of these took a slot for good. They are never user ids, which are UUIDs.
 */
const PER_CALL_KEY_PREFIXES = ["structured-", "settings-check-"] as const;

const OWNER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Whose slot a chat-engine launch runs in. Slots belong to people: a launch that names its
 * user gets that user's slot, the same one their chat agent and logins use. A per-call launch
 * that names no user is refused, because keying it by session would take a new slot per call.
 * Other unnamed launches (the bounded onboarding checks) keep their session key.
 */
export function uidSlotOwner(
  sessionKey: string,
  launch: {
    readonly userId?: unknown;
    readonly needsStructuredOutput?: boolean;
    readonly schema?: unknown;
  }
): string {
  if (launch.userId !== undefined) {
    if (typeof launch.userId !== "string" || !OWNER_ID_RE.test(launch.userId)) {
      throw new Error("launch.userId must match [A-Za-z0-9_-]{1,64}");
    }
    return launch.userId;
  }
  if (
    launch.needsStructuredOutput === true ||
    launch.schema !== undefined ||
    PER_CALL_KEY_PREFIXES.some((prefix) => sessionKey.startsWith(prefix))
  ) {
    throw new Error("launch names no owning user: refusing a per-call UID slot");
  }
  return sessionKey;
}

/**
 * Drop per-call entries left by the old session-keyed allocation, keeping every other entry
 * at its current number. Returns how many entries were dropped. Call only while no session
 * is live and after the neutral base is cleared (the runner's startup sweep).
 */
export function pruneUidSlots(homeBase: string): number {
  const slotFilePath = path.join(homeBase, SLOT_FILE);
  if (!fs.existsSync(slotFilePath)) return 0;
  const slots = readSlots(slotFilePath);
  const kept: Record<string, number> = {};
  let dropped = 0;
  for (const [key, slot] of Object.entries(slots)) {
    if (PER_CALL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))) dropped += 1;
    else kept[key] = slot;
  }
  if (dropped > 0) writeSlots(slotFilePath, kept);
  return dropped;
}

/** Every person holding a slot, without per-call entries. */
export function listUserUidSlots(
  homeBase: string
): { readonly userId: string; readonly uid: number; readonly gid: number }[] {
  const slots = readSlots(path.join(homeBase, SLOT_FILE));
  return Object.entries(slots)
    .filter(
      ([key]) =>
        OWNER_ID_RE.test(key) && !PER_CALL_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
    )
    .map(([userId, slot]) => ({ userId, uid: UID_BASE + slot, gid: GID_BASE + slot }));
}

/**
 * The user who holds the slot for `uid`, or undefined when no user does. Per-call entries left
 * by the old session-keyed allocation are not users, so they return undefined too.
 */
export function uidSlotUser(homeBase: string, uid: number): string | undefined {
  const slots = readSlots(path.join(homeBase, SLOT_FILE));
  const holder = Object.keys(slots).find((key) => UID_BASE + (slots[key] as number) === uid);
  if (holder === undefined) return undefined;
  if (PER_CALL_KEY_PREFIXES.some((prefix) => holder.startsWith(prefix))) return undefined;
  return OWNER_ID_RE.test(holder) ? holder : undefined;
}

function readSlots(slotFilePath: string): Record<string, number> {
  if (!fs.existsSync(slotFilePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(slotFilePath, "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeSlots(slotFilePath: string, slots: Record<string, number>): void {
  // Atomic write: tmp → rename (atomic on Linux, same filesystem).
  // Mode 0600: root-only; the map contains actorUserIds (PII, not for per-user UID reads).
  const tmpPath = slotFilePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(slots), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600); // override umask — must be root-only before rename
  fs.renameSync(tmpPath, slotFilePath);
}

/**
 * Best-effort: chown an existing per-session neutral dir to the newly allocated
 * uid/gid and set mode 0700. Called once on first slot allocation so files from
 * the old shared-UID era become accessible to the per-user UID.
 */
export function migrateNeutralDir(neutralDir: string, uid: number, gid: number): void {
  if (!fs.existsSync(neutralDir)) return;
  try {
    fs.chownSync(neutralDir, uid, gid);
    fs.chmodSync(neutralDir, 0o700);
  } catch {
    /* best-effort */
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(neutralDir);
  } catch {
    return;
  }
  for (const name of entries) {
    try {
      fs.chownSync(path.join(neutralDir, name), uid, gid);
    } catch {
      /* best-effort */
    }
  }
}
