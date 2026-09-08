/**
 * Build-command execution for one ACP session: `execStart`/`execPoll`/`execKill`
 * run a shell command in the session's project folder, cap its output, and
 * enforce a deadline that survives a runner restart. Split out of `acp-host.ts`
 * so that file stays focused on spawning and piping the adapter session itself
 * (task 5b, 2026-09-08 — the setpriv drop wiring pushed acp-host.ts past the
 * 1000-line gate).
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ACP_DEADLINE_DIR,
  execRecordPath,
  readExecRecord,
  writeExecRecord
} from "./exec-records.js";
import { prepareOwnedPathWithOwnership, type OwnershipApplier } from "./owned-fs.js";
import { buildSetprivDropCommand } from "./setpriv.js";
import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { allocateUidSlot } from "./uid-allocator.js";
import { sanitizeSessionKey } from "@moss/chat/live";

export interface AcpExecStartResult {
  readonly execId: number;
}

export interface AcpExecPollResult {
  /** Full output so far (stdout plus stderr, arrival order), capped at 256 KiB. */
  readonly output: string;
  readonly done: boolean;
  readonly exitCode: number | null;
  /** True once output past the cap was dropped; the head is what you get. */
  readonly truncated: boolean;
  /** True when the deadline killed the command; output is whatever ran so far. */
  readonly timedOut: boolean;
}

/** Single-line cap: matches the ACP session pipe's own line cap. */
const MAX_LINE_BYTES = 256 * 1024;
/**
 * Retained-output backstop for one build command: the head is kept, the tail
 * is dropped, and the poll reply says it was cut. Matches the tool contract.
 */
export const ACP_EXEC_OUTPUT_CAP_BYTES = 256 * 1024;
/** Default build deadline (5 min); the poller returns partial output past it. */
export const ACP_EXEC_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Upper bound for one build deadline (10 min); the runner never holds longer. */
export const ACP_EXEC_MAX_TIMEOUT_MS = 10 * 60 * 1000;
/** Finished build records are kept this long for a final poll, then swept. */
const EXEC_RETAIN_MS = 10 * 60 * 1000;
/** Backstop per session so one runaway agent cannot pile up build records. */
export const MAX_EXECS_PER_SESSION = 32;
/**
 * Backstop across all sessions so runs cannot pile up without bound. Eight
 * fully-loaded sessions fit; the 32-per-session cap still applies inside it.
 * Each record holds at most 256 KiB of output, so the worst case is 64 MiB
 * retained plus one process per running record.
 */
export const MAX_EXECS_TOTAL = 8 * MAX_EXECS_PER_SESSION;

interface AcpExec {
  readonly id: number;
  readonly child: ChildProcessWithoutNullStreams;
  output: string;
  outputBytes: number;
  truncated: boolean;
  timedOut: boolean;
  done: boolean;
  exitCode: number | null;
  lastActivity: number;
  deadline: ReturnType<typeof setTimeout> | null;
}

export interface AcpExecManagerDeps {
  readonly neutralBase: string;
  readonly homeBase?: string;
  readonly perUserUid?: boolean;
  readonly applyOwnership?: OwnershipApplier;
  readonly spawnExec?: (opts: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    uid?: number;
    gid?: number;
  }) => ChildProcessWithoutNullStreams;
}

/**
 * A process's actual start time in system ticks, read from the system process
 * table. Compared against the start time saved when the build was started:
 * only the same build is ever stopped. Null when the process is gone or the
 * table cannot be read — never a reason to kill.
 */
function readProcStartTime(pid: number): string | null {
  try {
    const content = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The second field (command name) may hold spaces and brackets, so split
    // after its closing bracket; the start time is the 22nd field overall.
    const closing = content.lastIndexOf(")");
    if (closing < 0) return null;
    const after = content.slice(closing + 2).split(" ");
    const startTime = after[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? startTime : null;
  } catch {
    return null;
  }
}

export class AcpExecManager {
  private readonly execs = new Map<string, Map<number, AcpExec>>();
  private execCounter = 0;
  /**
   * Kill timers armed for builds owned by a dead runner, keyed by record
   * file. Stops a restarted runner from arming the same deadline twice.
   */
  private readonly orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: AcpExecManagerDeps) {}

  /**
   * Stop builds that outlived the runner process that started them. Reads
   * every deadline record left on disk: builds past their deadline are
   * stopped at once, builds still within it get a kill timer in this process
   * so a second restart keeps them covered too. A record is only acted on
   * when the live process still has the start time saved in it, so a
   * recycled process number is never killed. Builds this runner is already
   * running are skipped: their live deadline owns them, and arming a second
   * timer would leave a kill aimed at nothing. Safe to call any number of
   * times. Must run after the startup clean-out, never beside it.
   */
  async reapOrphanedExecs(): Promise<void> {
    const deadlineBase = join(this.deps.neutralBase, ACP_DEADLINE_DIR);
    const sessionDirs = await readdir(deadlineBase, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const execDir = join(deadlineBase, entry.name);
      const files = await readdir(execDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const execId = Number(file.slice(0, -".json".length));
        const recordPath = join(execDir, file);
        if (this.orphanTimers.has(recordPath)) continue;
        if (Number.isInteger(execId)) {
          const live = this.execs.get(entry.name)?.get(execId);
          if (live && !live.done) continue;
        }
        const record = await readExecRecord(recordPath);
        if (!record) continue;
        const waitMs = record.deadlineAt - Date.now();
        if (waitMs <= 0) {
          await this.stopOrphan(recordPath);
        } else {
          const timer = setTimeout(() => {
            void this.stopOrphan(recordPath);
          }, waitMs);
          // A leftover deadline must never hold the runner process open.
          (timer as unknown as { unref?: () => void }).unref?.();
          this.orphanTimers.set(recordPath, timer);
        }
      }
      // Folders emptied by an earlier sweep — or by an owner that saw the
      // finish — would otherwise pile up under the spared folder forever.
      // Only an empty folder goes: anything else fails and simply stays.
      // This can still land inside a record write in progress, whose folder
      // sits empty until its file follows. That write rebuilds the folder
      // and tries once more, so the record lands unless the sweep wins the
      // race twice in a row. Past that point the build still starts, and the
      // caller logs that it could not save the deadline and carries on with
      // the one it holds in memory.
      await rmdir(execDir).catch(() => undefined);
    }
  }

  /**
   * Run one build command starting in the session project folder and return
   * its id. The caller names a project, never a folder: the working directory
   * is always `<neutralBase>/<sessionKey>/acp/<projectId>/`, the same folder
   * an adapter spawn for that session uses. The command itself is not
   * restricted to that folder. Output past 256 KiB is dropped (the poll reply
   * keeps the head and says it was cut); past the deadline the command is
   * killed and the poll reply carries whatever ran so far. The deadline is
   * also written to disk next to the session, so a restarted runner still
   * stops a build that outlived the process that started it.
   */
  async execStart(
    sessionKey: string,
    projectId: string,
    command: string,
    timeoutMs: number = ACP_EXEC_DEFAULT_TIMEOUT_MS
  ): Promise<AcpExecStartResult> {
    // Pick up deadlines left by a dead runner before admitting anything new.
    // A scan failure must never refuse a build; the constructor already tried.
    await this.reapOrphanedExecs().catch(() => undefined);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new Error("acpExecStart.projectId must match [A-Za-z0-9_-]{1,64}");
    }
    const key = sanitizeSessionKey(sessionKey);
    if (typeof command !== "string" || command.length === 0 || command.includes("\0")) {
      throw new Error("acpExecStart.command must be a non-empty string");
    }
    if (Buffer.byteLength(command, "utf8") > MAX_LINE_BYTES) {
      throw new Error("acpExecStart.command must be within 256 KiB");
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > ACP_EXEC_MAX_TIMEOUT_MS) {
      throw new Error("acpExecStart.timeoutMs must be a positive integer within 10 minutes");
    }

    let uid: number | undefined;
    let gid: number | undefined;
    if (this.deps.perUserUid && this.deps.homeBase) {
      const slot = allocateUidSlot(this.deps.homeBase, key);
      uid = slot.uid;
      gid = slot.gid;
    }
    const sessionDir = await prepareOwnedPathWithOwnership(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      [key, "acp", projectId],
      this.deps.applyOwnership
    );
    // The build's own home, in its own scratch area rather than the shared
    // home base, so the login token file is not under the build's home.
    const homeDir = await prepareOwnedPathWithOwnership(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      [key, "acp-home", projectId],
      this.deps.applyOwnership
    );

    // Scrubbed environment with the build's own home. What is actually true:
    // the build's home no longer points at the shared home, so the login
    // token is not in the child's home and nothing hands it over — but the
    // command is not confined, and one that goes looking under the shared
    // account can still reach the shared home. The runner's folder-naming
    // variables are dropped below so the environment does not point there
    // either. What stays (PATH, HOME, TERM, locale basics) is what a build
    // needs to run and carries no secret.
    const env: NodeJS.ProcessEnv = {
      ...buildSanitizedCliEnv(process.env),
      HOME: homeDir
    };
    for (const key of [
      "JARVIS_CLI_HOME",
      "MOSS_CLI_HOME",
      "JARVIS_CLI_HOME_BASE",
      "MOSS_CLI_HOME_BASE",
      "JARVIS_CLI_NEUTRAL_BASE",
      "MOSS_CLI_NEUTRAL_BASE"
    ]) {
      delete env[key];
    }
    const spawnExec =
      this.deps.spawnExec ??
      ((opts) => {
        // Same reasoning as the default spawnChild in acp-host.ts: the
        // launcher's own ambient capabilities would otherwise pass through
        // to this build command too, so setpriv switches to the person's
        // slot and drops every inheritable/ambient capability on the way.
        const launch =
          opts.uid !== undefined && opts.gid !== undefined
            ? buildSetprivDropCommand("sh", ["-c", opts.command], { uid: opts.uid, gid: opts.gid })
            : { command: "sh", args: ["-c", opts.command] };
        return spawn(launch.command, launch.args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true
          // stdin is ignored (builds never read it), so the stdio shape needs
          // the explicit step before it matches the session-child type.
        }) as unknown as ChildProcessWithoutNullStreams;
      });
    const child = spawnExec({ command, cwd: sessionDir, env, uid, gid });

    this.sweepExecs();
    let bySession = this.execs.get(key);
    try {
      if (bySession && bySession.size >= MAX_EXECS_PER_SESSION) {
        const oldestDone = [...bySession.values()].find((record) => record.done);
        if (!oldestDone)
          throw new Error("acpExecStart: too many running commands for this session");
        this.dropExec(key, bySession, oldestDone.id);
      } else if (this.totalExecCount() >= MAX_EXECS_TOTAL) {
        if (!this.evictOldestDoneExec()) {
          throw new Error("acpExecStart: too many running commands across sessions");
        }
      }
    } catch (error) {
      // The cap bounds running builds, not just records: a refused build is
      // stopped before the refusal leaves this function.
      this.killSpawnedChild(child);
      throw error;
    }
    bySession = this.execs.get(key) ?? new Map<number, AcpExec>();
    const id = (this.execCounter += 1);
    const recordPath = execRecordPath(this.deps.neutralBase, key, id);
    const record: AcpExec = {
      id,
      child,
      output: "",
      outputBytes: 0,
      truncated: false,
      timedOut: false,
      done: false,
      exitCode: null,
      lastActivity: Date.now(),
      deadline: null
    };
    const finish = (code: number | null): void => {
      if (record.done) return;
      record.done = true;
      record.exitCode = code;
      record.lastActivity = Date.now();
      if (record.deadline) {
        clearTimeout(record.deadline);
        record.deadline = null;
      }
      // The deadline no longer needs to survive anything: this runner saw the end.
      // Cancelling first matters: a backup timer armed by a restarted runner
      // would otherwise fire later against a recycled process number.
      this.cancelOrphanTimer(recordPath);
      try {
        unlinkSync(recordPath);
      } catch {
        /* never written, or the reaper already took it */
      }
    };
    child.stdout.on("data", (chunk: Buffer) => this.appendExecOutput(record, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.appendExecOutput(record, chunk));
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(null));
    const timer = setTimeout(() => {
      record.deadline = null;
      record.timedOut = true;
      record.lastActivity = Date.now();
      this.killExecProcess(record);
    }, timeoutMs);
    // The deadline must never hold the runner process open on its own.
    (timer as unknown as { unref?: () => void }).unref?.();
    record.deadline = timer;
    bySession.set(id, record);
    this.execs.set(key, bySession);
    // The deadline on disk is what lets a restarted runner stop this build.
    // A write failure is said out loud but never refuses the build: the
    // in-memory deadline still guards this runner's lifetime.
    await writeExecRecord(this.deps.neutralBase, key, id, {
      pid: child.pid,
      deadlineAt: Date.now() + timeoutMs,
      sessionKey: key,
      projectId,
      startedAt: Date.now(),
      startTime: child.pid === undefined ? null : readProcStartTime(child.pid)
    }).catch((error: unknown) => {
      console.warn(`[acp-host] ${key} could not persist build ${id}: ${(error as Error).message}`);
    });
    // A fast build may have finished while the record was being written, so
    // the finish handler already ran before there was a file to remove.
    // Leaving it behind would arm a kill against a recycled process number.
    const settled = bySession.get(id);
    if (!settled || settled.done) {
      try {
        unlinkSync(execRecordPath(this.deps.neutralBase, key, id));
      } catch {
        /* the finish handler already removed it */
      }
    }
    return { execId: id };
  }

  execPoll(sessionKey: string, execId: number): AcpExecPollResult {
    this.sweepExecs();
    const record = this.requireExec(sessionKey, execId);
    record.lastActivity = Date.now();
    return {
      output: record.output,
      done: record.done,
      exitCode: record.exitCode,
      truncated: record.truncated,
      timedOut: record.timedOut
    };
  }

  execKill(sessionKey: string, execId: number): void {
    this.sweepExecs();
    const key = sanitizeSessionKey(sessionKey);
    const record = this.execs.get(key)?.get(execId);
    // Idempotent like the adapter kill: an absent or finished command is a no-op.
    if (!record || record.done) return;
    this.killExecProcess(record);
  }

  /**
   * Carry out one leftover deadline: re-read the record (a missing record
   * means the owning runner saw the finish, so stand down), then stop the
   * process only when it still is the build the record names. The record is
   * removed either way, so one leftover never kills twice and the timer map
   * never grows past the records on disk.
   */
  private async stopOrphan(recordPath: string): Promise<void> {
    this.orphanTimers.delete(recordPath);
    const record = await readExecRecord(recordPath);
    if (!record) return;
    if (record.startTime !== null && readProcStartTime(record.pid) === record.startTime) {
      this.killPidGroup(record.pid);
    } else {
      console.warn(`[acp-host] orphan build record does not match a running build; dropping it`);
    }
    await unlink(recordPath).catch(() => undefined);
    // The sweep took the last record in this session folder: take the folder
    // too, so empty folders never pile up under the spared folder. Only an
    // empty folder goes — anything else fails and simply stays.
    await rmdir(dirname(recordPath)).catch(() => undefined);
  }

  /** Forget a backup timer armed for a build that has since finished. */
  private cancelOrphanTimer(recordPath: string): void {
    const timer = this.orphanTimers.get(recordPath);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.orphanTimers.delete(recordPath);
    }
  }

  /** Append build output up to the cap; past it the head is kept and the flag is set. */
  private appendExecOutput(record: AcpExec, chunk: Buffer): void {
    if (record.outputBytes >= ACP_EXEC_OUTPUT_CAP_BYTES) {
      record.truncated = true;
      return;
    }
    const text = chunk.toString("utf8");
    const room = ACP_EXEC_OUTPUT_CAP_BYTES - record.outputBytes;
    const size = Buffer.byteLength(text, "utf8");
    if (size <= room) {
      record.output += text;
      record.outputBytes += size;
    } else {
      // Head only; a split multibyte tail decodes to U+FFFD, and the flag says so.
      record.output += Buffer.from(text, "utf8").subarray(0, room).toString("utf8");
      record.outputBytes = ACP_EXEC_OUTPUT_CAP_BYTES;
      record.truncated = true;
    }
    record.lastActivity = Date.now();
  }

  private requireExec(sessionKey: string, execId: number): AcpExec {
    if (!Number.isInteger(execId) || execId <= 0) {
      throw new Error("acpExec.execId must be a positive integer");
    }
    const key = sanitizeSessionKey(sessionKey);
    const record = this.execs.get(key)?.get(execId);
    if (!record) throw new Error("Build command is not running");
    return record;
  }

  private dropExec(key: string, bySession: Map<number, AcpExec>, execId: number): void {
    const record = bySession.get(execId);
    bySession.delete(execId);
    if (record?.deadline) clearTimeout(record.deadline);
    this.cancelOrphanTimer(execRecordPath(this.deps.neutralBase, key, execId));
    try {
      unlinkSync(execRecordPath(this.deps.neutralBase, key, execId));
    } catch {
      /* never written, finished already, or the reaper took it */
    }
    if (bySession.size === 0) this.execs.delete(key);
  }

  /**
   * Best-effort stop of one process group by id, for builds owned by a dead
   * runner where no child handle exists. A missing process is the common
   * case (it exited on its own) and is not an error.
   */
  private killPidGroup(pid: number): void {
    try {
      process.kill(-pid, "SIGTERM");
      return;
    } catch {
      /* fall through to the direct kill */
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /** Every build record held right now, finished or running, in every session. */
  private totalExecCount(): number {
    let total = 0;
    for (const bySession of this.execs.values()) total += bySession.size;
    return total;
  }

  /**
   * Drop the longest-idle finished build across all sessions to make room for
   * a new one. Running builds are never dropped: when everything held is
   * still running there is nothing safe to make room with. Returns true when
   * a record was dropped.
   */
  private evictOldestDoneExec(): boolean {
    let oldestKey: string | null = null;
    let oldestSession: Map<number, AcpExec> | null = null;
    let oldestId = -1;
    let oldestActivity = Number.POSITIVE_INFINITY;
    for (const [key, bySession] of this.execs) {
      for (const [id, record] of bySession) {
        if (record.done && record.lastActivity < oldestActivity) {
          oldestKey = key;
          oldestSession = bySession;
          oldestId = id;
          oldestActivity = record.lastActivity;
        }
      }
    }
    if (oldestKey === null || oldestSession === null) return false;
    this.dropExec(oldestKey, oldestSession, oldestId);
    return true;
  }

  /**
   * Best-effort stop of a child that was started but will never be tracked
   * (cap refusal): the group first, then the child directly. The process may
   * already be gone; that is not an error.
   */
  private killSpawnedChild(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        /* fall through to the direct kill */
      }
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /** Best-effort process-group kill for one build; the exit handler settles the record. */
  private killExecProcess(record: AcpExec): void {
    if (record.done) return;
    const pid = record.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        /* fall through to the direct kill */
      }
    }
    try {
      record.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  /** Drop finished build records past their retain window so polling clients can go away. */
  private sweepExecs(): void {
    const now = Date.now();
    for (const [key, bySession] of this.execs) {
      for (const [id, record] of bySession) {
        if (record.done && now - record.lastActivity > EXEC_RETAIN_MS) {
          this.dropExec(key, bySession, id);
        }
      }
    }
  }
}
