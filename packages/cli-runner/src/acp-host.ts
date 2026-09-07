/**
 * AcpHost — spawns the ACP adapter (Claude Code via its ACP bridge) as the session
 * user and pipes its stdio lines for the API-side client in `@moss/acp` (#2369 slice 1).
 *
 * The runner is deliberately a dumb line pipe: it never parses ACP JSON. Spawning
 * mirrors the chat engine topology (sanitized env, per-user UID when enabled, HOME at
 * the shared home base, per-session working folder), and the vendor login reaches the
 * child through its environment, never the command line.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ACP_DEADLINE_DIR,
  execRecordPath,
  readExecRecord,
  writeExecRecord
} from "./exec-records.js";
import { prepareOwnedPath, writeOwnedFile } from "./owned-fs.js";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { allocateUidSlot } from "./uid-allocator.js";
import { providerTokenPath } from "./provider-token-store.js";
import { redactSecrets } from "@moss/ai";
import { sanitizeSessionKey } from "@moss/chat/live";

export interface AcpHostDeps {
  readonly neutralBase: string;
  readonly homeBase?: string;
  /** Mirrors the engine host flag: setuid spawn only with a root container. */
  readonly perUserUid?: boolean;
  /** Resolves the adapter entry file; injected so tests never touch node_modules. */
  readonly resolveAdapterEntry?: () => string;
  /** Reads a file; injected so tests can stub the login token. */
  readonly readTokenFile?: (path: string) => Promise<string>;
  /**
   * Spawns the adapter child; injected so tests never start a process. The
   * production default is a piped-stdio spawn under the session identity.
   */
  readonly spawnChild?: (opts: {
    entry: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    uid?: number;
    gid?: number;
  }) => ChildProcessWithoutNullStreams;
  /**
   * Spawns one build command; injected so tests never start a process. The
   * production default runs `sh -c` in the session project folder under the
   * session identity, with a scrubbed environment and no vendor login.
   */
  readonly spawnExec?: (opts: {
    command: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    uid?: number;
    gid?: number;
  }) => ChildProcessWithoutNullStreams;
}

export interface AcpSpawnResult {
  readonly cwd: string;
  readonly generation: number;
  /** The HOME handed to the agent process, or null when it names none. */
  readonly home: string | null;
}

export interface AcpReadResult {
  readonly lines: readonly string[];
  readonly firstSeq: number;
  readonly nextSeq: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
  /**
   * True when this reply — or an earlier one — was cut: the reply exceeded the
   * total cap, or the buffer dropped lines the reader had not seen yet.
   */
  readonly truncated: boolean;
}

/** Buffered stdout lines per session; the API drains them with a sequence cursor. */
const MAX_BUFFERED_LINES = 500;
/** Retained-bytes backstop per session: the buffer must stay far below the frame cap. */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
/** One read reply may never approach the RPC frame cap; the flag says it was cut. */
const MAX_REPLY_BYTES = 1024 * 1024;
/** Idle sessions are reaped on the next call so a dead API cannot leak agents. */
const IDLE_REAP_MS = 30 * 60 * 1000;
/** Single-line cap: a pathological stdout line must not blow the RPC frame cap. */
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

interface AcpSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly generation: number;
  buffered: string[];
  bufferedBytes: number;
  nextSeq: number;
  /**
   * Highest cursor the reader has passed: lines at or below it were seen, so
   * trimming them loses nothing. Lines above it are still owed to the reader.
   */
  deliveredSeq: number;
  /**
   * Sticky: set when the buffer drops lines the reader had not seen, or a reply
   * is cut by the total cap. Later reads keep saying so — data upstream is gone.
   */
  truncated: boolean;
  exited: boolean;
  exitCode: number | null;
  lastActivity: number;
}

function defaultResolveAdapterEntry(): string {
  return createRequire(import.meta.url).resolve("@zed-industries/claude-code-acp/dist/index.js");
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

export class AcpHost {
  private readonly sessions = new Map<string, AcpSession>();
  private generationCounter = 0;
  private readonly execs = new Map<string, Map<number, AcpExec>>();
  private execCounter = 0;
  /**
   * Kill timers armed for builds owned by a dead runner, keyed by record
   * file. Stops a restarted runner from arming the same deadline twice.
   */
  private readonly orphanTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: AcpHostDeps) {
    // No sweep here: the constructor cannot wait, and an unwaited sweep
    // races the startup clean-out over the same folder. The engine runs the
    // sweep after its clean-out, and every build start runs it as a backstop.
  }

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
      // and tries once more, so the record still lands.
      await rmdir(execDir).catch(() => undefined);
    }
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

  async spawn(sessionKey: string, projectId: string): Promise<AcpSpawnResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new Error("acpSpawn.projectId must match [A-Za-z0-9_-]{1,64}");
    }
    const key = sanitizeSessionKey(sessionKey);
    this.killRecord(key);

    let uid: number | undefined;
    let gid: number | undefined;
    if (this.deps.perUserUid && this.deps.homeBase) {
      const slot = allocateUidSlot(this.deps.homeBase, key);
      uid = slot.uid;
      gid = slot.gid;
    }
    // Same link-safe folder setup the build path uses, at every level: a
    // command that ran here earlier can plant a link at this folder or any of
    // its parents, so each level is cleared of links and verified before the
    // next builds on it. Owner-only whatever the identity option says: with
    // it off every session shares one account, so this narrows nothing
    // between people — the real containment there is the disabled built-ins
    // plus the per-session folder (asserted in cli-runner-acp-host.test.ts),
    // not these bits. Still the only safe default: group and world get
    // nothing.
    const sessionDir = await prepareOwnedPath(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      key,
      "acp",
      projectId
    );

    // Project settings at the path the adapter actually reads
    // (<cwd>/.claude/settings.json). A bare tool name denies every use of it,
    // so even an adapter that ignored the disabled-built-ins flag could neither
    // shell out nor write. Written before spawn so the first session is scoped.
    const settingsDir = await prepareOwnedPath(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      key,
      "acp",
      projectId,
      ".claude"
    );
    const settingsPath = join(settingsDir, "settings.json");
    // Belt and braces with the policy: the shell and writer names stay off, and
    // reads of the login-token corners plus the system pseudofolders are denied
    // even if a future adapter ever launched those tools. Whether the vendor
    // matcher honors these rules needs a live check in phase 5.
    await writeOwnedFile(
      key,
      settingsPath,
      JSON.stringify({
        permissions: {
          deny: [
            "Bash",
            "KillShell",
            "Write",
            "Edit",
            "MultiEdit",
            "NotebookEdit",
            "Read(~/.jarvis/**)",
            "Read(~/.claude/**)",
            "Read(~/.claude.json)",
            "Read(~/.codex/**)",
            "Read(~/.gemini/**)",
            "Read(//proc/**)",
            "Read(//sys/**)",
            "Read(//dev/**)",
            "Read(//run/**)"
          ]
        }
      }),
      uid,
      gid
    );

    const env: NodeJS.ProcessEnv = {
      ...buildSanitizedCliEnv(process.env),
      ...(this.deps.homeBase ? { HOME: this.deps.homeBase } : {})
    };
    // Same login the chat engine uses: the stored subscription token, via the
    // environment only — never argv (which leaks through `ps`).
    if (this.deps.homeBase) {
      const token = await this.readLoginToken(this.deps.homeBase);
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }

    const entry = this.deps.resolveAdapterEntry?.() ?? defaultResolveAdapterEntry();
    const spawnChild =
      this.deps.spawnChild ??
      ((opts) =>
        // detached: the adapter owns a process group, so kill takes down the
        // whole tree (the agent SDK's own CLI grandchild included) — a plain
        // child.kill would orphan it. Same shape as the persistent chat runtime.
        spawn(process.execPath, [opts.entry], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true,
          ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
          ...(opts.gid !== undefined ? { gid: opts.gid } : {})
        }) as ChildProcessWithoutNullStreams);
    const child = spawnChild({ entry, cwd: sessionDir, env, uid, gid });

    const session: AcpSession = {
      child,
      cwd: sessionDir,
      generation: (this.generationCounter += 1),
      buffered: [],
      bufferedBytes: 0,
      nextSeq: 0,
      deliveredSeq: 0,
      truncated: false,
      exited: false,
      exitCode: null,
      lastActivity: Date.now()
    };
    let pending = "";
    child.stdout.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) {
        const trimmed = line.length > MAX_LINE_BYTES ? line.slice(0, MAX_LINE_BYTES) : line;
        if (trimmed.length === 0) continue;
        session.buffered.push(trimmed);
        session.bufferedBytes += Buffer.byteLength(trimmed, "utf8");
        session.nextSeq += 1;
        this.trimRetained(session);
      }
      session.lastActivity = Date.now();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Adapter diagnostics ride stderr by design (stdout is protocol). Keep the
      // tail in the runner log, truncated and redacted, never the full stream.
      const text = redactSecrets(chunk.toString("utf8")).slice(-2000);
      console.warn(`[acp-host] ${key} stderr: ${text}`);
    });
    child.on("exit", (code) => {
      session.exited = true;
      session.exitCode = code;
      session.lastActivity = Date.now();
    });
    child.on("error", () => {
      session.exited = true;
      session.lastActivity = Date.now();
    });
    this.sessions.set(key, session);
    // The agent's home travels with the spawn result so the permission policy
    // can refuse its sensitive corners without ever reading them. Null when
    // the child environment names no home.
    const home = typeof env.HOME === "string" && env.HOME !== "" ? env.HOME : null;
    return { cwd: sessionDir, generation: session.generation, home };
  }

  send(sessionKey: string, line: string): void {
    this.sweepIdle();
    const session = this.requireLive(sessionKey);
    if (line.length === 0 || line.length > MAX_LINE_BYTES) {
      throw new Error("acpSend.line must be a non-empty line within 256 KiB");
    }
    if (line.includes("\n")) {
      throw new Error("acpSend.line must be a single line");
    }
    session.child.stdin.write(`${line}\n`);
    session.lastActivity = Date.now();
  }

  read(sessionKey: string, afterSeq: number): AcpReadResult {
    this.sweepIdle();
    const key = sanitizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) throw new Error("ACP session is not running");
    if (!Number.isInteger(afterSeq) || afterSeq < 0) {
      throw new Error("acpRead.afterSeq must be a non-negative integer");
    }
    const start = Math.max(0, session.nextSeq - session.buffered.length);
    const fresh =
      afterSeq < start ? [...session.buffered] : session.buffered.slice(afterSeq - start);
    // The whole reply stays far below the frame cap: cut lines past it and say
    // so plainly, so one talkative agent can never close the shared connection.
    const lines: string[] = [];
    let bytes = 0;
    let cut = false;
    for (const line of fresh) {
      const size = Buffer.byteLength(line, "utf8");
      if (bytes + size > MAX_REPLY_BYTES) {
        cut = true;
        break;
      }
      lines.push(line);
      bytes += size;
    }
    if (cut || session.truncated) session.truncated = true;
    session.deliveredSeq = Math.max(session.deliveredSeq, afterSeq);
    session.lastActivity = Date.now();
    return {
      lines,
      firstSeq: lines.length > 0 ? (afterSeq < start ? start + 1 : afterSeq + 1) : session.nextSeq,
      nextSeq: session.nextSeq,
      exited: session.exited,
      exitCode: session.exitCode,
      truncated: session.truncated
    };
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
    const sessionDir = await prepareOwnedPath(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      key,
      "acp",
      projectId
    );
    // The build's own home, in its own scratch area rather than the shared
    // home base, so the login token file is not under the build's home.
    const homeDir = await prepareOwnedPath(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      key,
      "acp-home",
      projectId
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
      ((opts) =>
        spawn("sh", ["-c", opts.command], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
          ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
          ...(opts.gid !== undefined ? { gid: opts.gid } : {})
          // stdin is ignored (builds never read it), so the stdio shape needs
          // the explicit step before it matches the session-child type.
        }) as unknown as ChildProcessWithoutNullStreams);
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
   * Keep the retained buffer small. Lines the reader has already passed go
   * first; lines it is still owed are kept unless the buffer is far past its
   * backstop, and then the sticky flag records the loss.
   */
  private trimRetained(session: AcpSession): void {
    while (
      (session.buffered.length > MAX_BUFFERED_LINES || session.bufferedBytes > MAX_BUFFER_BYTES) &&
      session.buffered.length > 0
    ) {
      const oldestSeq = session.nextSeq - session.buffered.length + 1;
      if (oldestSeq > session.deliveredSeq) session.truncated = true;
      const dropped = session.buffered.shift() as string;
      session.bufferedBytes -= Buffer.byteLength(dropped, "utf8");
    }
  }

  kill(sessionKey: string, expectedGeneration?: number): void {
    this.sweepIdle();
    const key = sanitizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) return;
    // A guarded kill from a dropped connection must not take down a session
    // another connection respawned after it: generations differ, so no-op.
    if (expectedGeneration !== undefined && session.generation !== expectedGeneration) return;
    this.killRecord(key);
  }

  private requireLive(sessionKey: string): AcpSession {
    const key = sanitizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) throw new Error("ACP session is not running");
    if (session.exited) throw new Error("ACP session has exited");
    return session;
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

  private killRecord(key: string): void {
    const session = this.sessions.get(key);
    this.sessions.delete(key);
    if (!session || session.exited) return;
    // Kill the group first (adapter plus any CLI grandchild), then fall back to
    // the direct child. Every step is best-effort: the process may already be gone.
    const pid = session.child.pid;
    if (pid !== undefined) {
      try {
        process.kill(-pid, "SIGTERM");
        return;
      } catch {
        /* fall through to the direct kill */
      }
    }
    try {
      session.child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_REAP_MS) this.killRecord(key);
    }
  }

  private async readLoginToken(homeBase: string): Promise<string | null> {
    try {
      const read = this.deps.readTokenFile ?? ((p: string) => readFile(p, "utf8"));
      const token = (await read(providerTokenPath(homeBase, "anthropic"))).trim();
      return token.length > 0 ? token : null;
    } catch {
      return null;
    }
  }
}
