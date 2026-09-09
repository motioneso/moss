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

/** Top-level folder under the runner base holding ACP private-purge markers. */
export const ACP_PRIVATE_MARKER_DIR = "acp-private-markers";

export interface AcpPrivateMarkerRecord {
  readonly sessionKey: string;
  readonly cwd: string;
  readonly home: string;
  readonly uid: number;
  readonly gid: number;
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

/** Read one session's marker; null when missing or not what this module wrote. */
export async function readAcpPrivateMarker(
  baseDir: string,
  key: string
): Promise<AcpPrivateMarkerRecord | null> {
  try {
    const raw = JSON.parse(await readFile(markerPath(baseDir, key), "utf8")) as Partial<
      Record<keyof AcpPrivateMarkerRecord, unknown>
    >;
    if (
      typeof raw.sessionKey !== "string" ||
      typeof raw.cwd !== "string" ||
      typeof raw.home !== "string" ||
      typeof raw.uid !== "number" ||
      typeof raw.gid !== "number"
    ) {
      return null;
    }
    return {
      sessionKey: raw.sessionKey,
      cwd: raw.cwd,
      home: raw.home,
      uid: raw.uid,
      gid: raw.gid
    };
  } catch {
    return null;
  }
}

/** Remove one session's marker; a no-op when it is already gone. */
export async function removeAcpPrivateMarker(baseDir: string, key: string): Promise<void> {
  await rm(markerPath(baseDir, key), { force: true }).catch(() => undefined);
}

/** Every session key with a marker on disk right now, for a boot-time sweep. */
export async function listAcpPrivateMarkerKeys(baseDir: string): Promise<string[]> {
  try {
    const names = await readdir(join(baseDir, ACP_PRIVATE_MARKER_DIR));
    return names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}
