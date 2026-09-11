/**
 * Runner-owned markers for ACP chat-profile scratch folders.
 *
 * The chat profile always runs the agent inside an empty scratch folder
 * (spec: docs/superpowers/specs/2026-09-06-acp-client-design.md) that must
 * not survive past the live session, regardless of whether the specific
 * conversation is marked private in Moss's own database. Only the runner,
 * through setpriv as the folder's owning account, can enter it — so the
 * runner leaves itself one marker per chat-profile spawn, in the one folder
 * the startup clean-out spares, naming the folder to purge and the account
 * that owns it. A marker is removed only once its folder is confirmed
 * purged; a marker a restart finds still there means the matching purge
 * never finished, and the boot sweep retries it.
 */

import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { prepareOwnedPath, writeOwnedFile } from "./owned-fs.js";
import type { AcpProviderKind } from "@moss/acp";

/** Top-level folder under the runner base holding ACP private-purge markers. */
export const ACP_PRIVATE_MARKER_DIR = "acp-private-markers";

export interface AcpPrivateMarkerRecord {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly home: string;
  readonly uid: number;
  readonly gid: number;
  /** Which adapter ran here, so a boot sweep knows which provider transcript store to purge. */
  readonly provider: AcpProviderKind;
  /**
   * The spawned agent's own process id, and its start time read from the system at spawn
   * (see readProcStartTime in acp-execs.ts) — null until the process actually exists. A boot
   * sweep compares the live start time against this before purging: a match means the process
   * this marker was written for is still running and must be stopped first; a mismatch or a
   * gone process means it is safe to purge straight away.
   */
  readonly pid: number | null;
  readonly startTime: string | null;
}

function markerFileName(key: string): string {
  return `${key}.json`;
}

function markerPath(baseDir: string, key: string): string {
  return join(baseDir, ACP_PRIVATE_MARKER_DIR, markerFileName(key));
}

/**
 * Persist one chat-profile session's purge marker. The folder is built
 * link-safe and the file goes through the same no-follow write as every
 * other runner-owned file, so a planted link redirects or receives nothing.
 */
export async function writeAcpPrivateMarker(
  baseDir: string,
  key: string,
  record: AcpPrivateMarkerRecord
): Promise<void> {
  const content = JSON.stringify(record);
  const writeOnce = async (dir: string): Promise<void> => {
    await writeOwnedFile(key, join(dir, markerFileName(key)), content);
  };
  const dir = await prepareOwnedPath(baseDir, key, ACP_PRIVATE_MARKER_DIR);
  try {
    await writeOnce(dir);
  } catch (error) {
    // A concurrent sweep can remove this folder between it being built above
    // and the file landing here (mirrors writeExecRecord's ENOENT retry).
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    const rebuilt = await prepareOwnedPath(baseDir, key, ACP_PRIVATE_MARKER_DIR);
    await writeOnce(rebuilt);
  }
}

/**
 * Reading a marker back has three outcomes, and a boot sweep must not treat them alike:
 * "missing" means there is truly nothing to purge, so the (already-absent) marker can be
 * dropped from bookkeeping. "invalid" means the marker exists but cannot be trusted — a
 * partial write, disk corruption, or a read error other than not-found — and purging blind
 * would either miss a real folder or act on the wrong one, so the marker must be LEFT so the
 * sweep counts as incomplete and a later run (or an operator) can look at it (Astra-Reviewer
 * finding, 2026-09-09: a failed read used to be silently treated as "gone").
 */
export type AcpPrivateMarkerReadResult =
  | { readonly status: "ok"; readonly record: AcpPrivateMarkerRecord }
  | { readonly status: "missing" }
  | { readonly status: "invalid" };

/** Read one session's marker, distinguishing "gone" from "unreadable" (see the type above). */
export async function readAcpPrivateMarker(
  baseDir: string,
  key: string
): Promise<AcpPrivateMarkerReadResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(markerPath(baseDir, key), "utf8"));
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid" };
  }
  // A file whose whole content parses to something other than a plain object —
  // literal `null`, a number, an array — has no fields to check below; treat it
  // the same as any other unreadable marker instead of throwing past the caller.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "invalid" };
  }
  const raw = parsed as Partial<Record<keyof AcpPrivateMarkerRecord, unknown>>;
  if (
    typeof raw.sessionKey !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.home !== "string" ||
    typeof raw.uid !== "number" ||
    typeof raw.gid !== "number" ||
    (raw.provider !== "anthropic" && raw.provider !== "openai" && raw.provider !== "opencode") ||
    (raw.pid !== null && typeof raw.pid !== "number") ||
    (raw.startTime !== null && typeof raw.startTime !== "string")
  ) {
    return { status: "invalid" };
  }
  return {
    status: "ok",
    record: {
      sessionKey: raw.sessionKey,
      cwd: raw.cwd,
      home: raw.home,
      uid: raw.uid,
      gid: raw.gid,
      provider: raw.provider,
      pid: (raw.pid as number | null | undefined) ?? null,
      startTime: (raw.startTime as string | null | undefined) ?? null
    }
  };
}

/** Remove one session's marker; a no-op when it is already gone. */
export async function removeAcpPrivateMarker(baseDir: string, key: string): Promise<void> {
  await rm(markerPath(baseDir, key), { force: true }).catch(() => undefined);
}

/**
 * Every session key with a marker on disk right now, for a boot-time sweep. Throws when the
 * marker folder cannot be listed for a reason other than it never having been created — a
 * permission or I/O error is not proof the folder is empty, and a caller that read it as such
 * would run its wholesale clear over private folders it never actually checked.
 */
export async function listAcpPrivateMarkerKeys(baseDir: string): Promise<string[]> {
  try {
    const names = await readdir(join(baseDir, ACP_PRIVATE_MARKER_DIR));
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}
