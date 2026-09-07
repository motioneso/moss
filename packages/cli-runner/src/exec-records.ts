/**
 * Restart-proof build deadline records.
 *
 * Each running build leaves one small file naming its process, its deadline,
 * and the process's actual start time. A restarted runner reads these to stop
 * builds that outlived the process that started them — stopping only the
 * process whose live start time still matches, so a recycled process number
 * is never killed. Records live in the one folder the startup clean-out
 * spares, are written link-safe, and are removed when the owning runner sees
 * the finish.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { prepareOwnedPath, writeOwnedFile } from "./owned-fs.js";

/**
 * Top-level folder under the runner base holding build deadline records.
 * It is the one folder the startup clean-out spares, so a deadline survives
 * the very restart it exists for.
 */
export const ACP_DEADLINE_DIR = "acp-deadlines";

/**
 * Smallest unit of a build record kept on disk: what a restarted runner needs
 * to stop a build that outlived the process that started it.
 */
export interface ExecDeadlineRecord {
  readonly pid: number;
  /** Epoch milliseconds when the build must be stopped. */
  readonly deadlineAt: number;
  readonly sessionKey: string;
  readonly projectId: string;
  readonly startedAt: number;
  /**
   * The build's actual start time read from the system at spawn, in system
   * ticks. Compared against the live process before any kill, so a recycled
   * process number can never aim the kill at something else. Null when the
   * system would not say: such a record is never acted on.
   */
  readonly startTime: string | null;
}

/** Where one build's restart-proof deadline lives. */
export function execRecordPath(baseDir: string, key: string, execId: number): string {
  return join(baseDir, ACP_DEADLINE_DIR, key, `${execId}.json`);
}

/**
 * Persist one build's deadline. Skipped when the child has no process id
 * (injected test doubles): there is nothing a restarted runner could stop.
 * The folder levels are built link-safe and the file goes through the same
 * no-follow write as the adapter settings, so a planted link redirects or
 * receives nothing.
 */
export async function writeExecRecord(
  baseDir: string,
  key: string,
  execId: number,
  record: Omit<ExecDeadlineRecord, "pid"> & { pid: number | undefined }
): Promise<void> {
  if (record.pid === undefined) return;
  const dir = await prepareOwnedPath(baseDir, key, undefined, undefined, ACP_DEADLINE_DIR, key);
  const { pid, ...rest } = record;
  await writeOwnedFile(
    key,
    join(dir, `${execId}.json`),
    JSON.stringify({ pid, ...rest }),
    undefined,
    undefined
  );
}

/** Read one deadline record; null when it is missing or not what we wrote. */
export async function readExecRecord(path: string): Promise<ExecDeadlineRecord | null> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as Partial<ExecDeadlineRecord>;
    if (
      typeof raw.pid !== "number" ||
      !Number.isInteger(raw.pid) ||
      raw.pid <= 0 ||
      typeof raw.deadlineAt !== "number" ||
      !Number.isFinite(raw.deadlineAt)
    ) {
      return null;
    }
    return {
      pid: raw.pid,
      deadlineAt: raw.deadlineAt,
      sessionKey: typeof raw.sessionKey === "string" ? raw.sessionKey : "",
      projectId: typeof raw.projectId === "string" ? raw.projectId : "",
      startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0,
      startTime: typeof raw.startTime === "string" ? raw.startTime : null
    };
  } catch {
    return null;
  }
}
