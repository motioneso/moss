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
import { O_CREAT, O_DIRECTORY, O_NOFOLLOW, O_RDONLY, O_TRUNC, O_WRONLY } from "node:constants";
import { createRequire } from "node:module";
import { lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

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
/**
 * Smallest unit of a build record kept on disk: what a restarted runner needs
 * to stop a build that outlived the process that started it.
 */
interface ExecDeadlineRecord {
  readonly pid: number;
  /** Epoch milliseconds when the build must be stopped. */
  readonly deadlineAt: number;
  readonly sessionKey: string;
  readonly projectId: string;
  readonly startedAt: number;
}

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
    // A restart throws away every in-memory deadline while the builds keep
    // running detached, so the first thing a new runner does is pick up the
    // deadlines left on disk. Fire-and-forget: a scan failure must never stop
    // the runner from starting; execStart runs the same pass awaited.
    void this.reapOrphanedExecs().catch((error: unknown) => {
      console.warn(`[acp-host] orphan build sweep failed: ${(error as Error).message}`);
    });
  }

  /**
   * Stop builds that outlived the runner process that started them. Reads
   * every deadline record left on disk: builds past their deadline are
   * stopped at once, builds still within it get a kill timer in this process
   * so a second restart keeps them covered too. Unreadable records are left
   * alone. Safe to call any number of times.
   */
  async reapOrphanedExecs(): Promise<void> {
    const base = this.deps.neutralBase;
    const sessionDirs = await readdir(base, { withFileTypes: true }).catch(() => []);
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const execDir = join(base, entry.name, "acp-exec");
      const files = await readdir(execDir).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".json")) continue;
        const recordPath = join(execDir, file);
        if (this.orphanTimers.has(recordPath)) continue;
        const record = await this.readExecRecord(recordPath);
        if (!record) continue;
        const waitMs = record.deadlineAt - Date.now();
        if (waitMs <= 0) {
          this.killPidGroup(record.pid);
          await unlink(recordPath).catch(() => undefined);
        } else {
          const timer = setTimeout(() => {
            this.orphanTimers.delete(recordPath);
            this.killPidGroup(record.pid);
            void unlink(recordPath).catch(() => undefined);
          }, waitMs);
          // A leftover deadline must never hold the runner process open.
          (timer as unknown as { unref?: () => void }).unref?.();
          this.orphanTimers.set(recordPath, timer);
        }
      }
    }
  }

  async spawn(sessionKey: string, projectId: string): Promise<AcpSpawnResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new Error("acpSpawn.projectId must match [A-Za-z0-9_-]{1,64}");
    }
    const key = sanitizeSessionKey(sessionKey);
    this.killRecord(key);

    const sessionDir = join(this.deps.neutralBase, key, "acp", projectId);

    let uid: number | undefined;
    let gid: number | undefined;
    if (this.deps.perUserUid && this.deps.homeBase) {
      const slot = allocateUidSlot(this.deps.homeBase, key);
      uid = slot.uid;
      gid = slot.gid;
    }
    // Same link-safe folder setup the build path uses: a command that ran
    // here earlier can swap this folder for a link elsewhere, so a planted
    // link is removed and the real folder is verified before use. Owner-only
    // whatever the identity option says: with it off every session shares one
    // account, so this narrows nothing between people — the real containment
    // there is the disabled built-ins plus the per-session folder (asserted
    // in cli-runner-acp-host.test.ts), not these bits. Still the only safe
    // default: group and world get nothing.
    await this.prepareOwnedDir(key, sessionDir, uid, gid);

    // Project settings at the path the adapter actually reads
    // (<cwd>/.claude/settings.json). A bare tool name denies every use of it,
    // so even an adapter that ignored the disabled-built-ins flag could neither
    // shell out nor write. Written before spawn so the first session is scoped.
    const settingsDir = join(sessionDir, ".claude");
    await this.prepareOwnedDir(key, settingsDir, uid, gid);
    const settingsPath = join(settingsDir, "settings.json");
    // Belt and braces with the policy: the shell and writer names stay off, and
    // reads of the login-token corners plus the system pseudofolders are denied
    // even if a future adapter ever launched those tools. Whether the vendor
    // matcher honors these rules needs a live check in phase 5.
    await this.writeOwnedFile(
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

    const sessionDir = join(this.deps.neutralBase, key, "acp", projectId);
    // The build's own home, in its own scratch area rather than the shared
    // home base, so the login token file is not under the build's home.
    const homeDir = join(this.deps.neutralBase, key, "acp-home", projectId);

    let uid: number | undefined;
    let gid: number | undefined;
    if (this.deps.perUserUid && this.deps.homeBase) {
      const slot = allocateUidSlot(this.deps.homeBase, key);
      uid = slot.uid;
      gid = slot.gid;
    }
    await this.prepareOwnedDir(key, sessionDir, uid, gid);
    await this.prepareOwnedDir(key, homeDir, uid, gid);

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
    if (bySession && bySession.size >= MAX_EXECS_PER_SESSION) {
      const oldestDone = [...bySession.values()].find((record) => record.done);
      if (!oldestDone) throw new Error("acpExecStart: too many running commands for this session");
      this.dropExec(key, bySession, oldestDone.id);
    } else if (this.totalExecCount() >= MAX_EXECS_TOTAL) {
      if (!this.evictOldestDoneExec()) {
        throw new Error("acpExecStart: too many running commands across sessions");
      }
    }
    bySession = this.execs.get(key) ?? new Map<number, AcpExec>();
    const id = (this.execCounter += 1);
    const recordPath = this.execRecordPath(key, id);
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
    await this.writeExecRecord(key, id, {
      pid: child.pid,
      deadlineAt: Date.now() + timeoutMs,
      sessionKey: key,
      projectId,
      startedAt: Date.now()
    }).catch((error: unknown) => {
      console.warn(`[acp-host] ${key} could not persist build ${id}: ${(error as Error).message}`);
    });
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

  /**
   * Make path a real folder owned by the session without ever following a
   * link. A command that ran here earlier can swap the folder for a link to
   * somewhere else; a plain make-folder plus lock-bits would then set owner
   * only bits (and ownership) on the wrong place. So a planted link is
   * removed, the real folder is created, it is verified to be a folder, and
   * the bits are set through a handle opened with O_NOFOLLOW, which refuses
   * to resolve to anything but this folder.
   */
  private async prepareOwnedDir(
    key: string,
    path: string,
    uid: number | undefined,
    gid: number | undefined
  ): Promise<void> {
    const first = await lstat(path).catch(() => null);
    if (first && first.isSymbolicLink()) await unlink(path);
    await mkdir(path, { recursive: true });
    const verified = await lstat(path).catch(() => null);
    if (!verified || !verified.isDirectory() || verified.isSymbolicLink()) {
      throw new Error("AcpHost: session folder is not a folder");
    }
    const handle = await open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    try {
      try {
        await handle.chmod(0o700);
      } catch (error) {
        console.warn(
          `[acp-host] ${key} could not lock the project folder owner-only: ${(error as Error).message}`
        );
      }
      if (uid !== undefined && gid !== undefined) {
        try {
          await handle.chown(uid, gid);
        } catch (error) {
          console.warn(
            `[acp-host] ${key} could not hand the project folder to its owner: ${(error as Error).message}`
          );
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /**
   * Write content to path without ever following a link. A command that ran
   * here earlier can plant a link where the settings file goes; a plain write
   * would then overwrite the wrong place. So a planted link is removed first
   * and the file is opened with O_NOFOLLOW, which refuses to resolve to
   * anything but this file — a link re-planted in between fails closed
   * instead of writing through. Owner-only bits and handover go through the
   * open handle, so they can only land on this file. A failure to lock or
   * hand over is said out loud: silent best-effort is how isolation ends up
   * missing with nobody knowing.
   */
  private async writeOwnedFile(
    key: string,
    path: string,
    content: string,
    uid: number | undefined,
    gid: number | undefined
  ): Promise<void> {
    const first = await lstat(path).catch(() => null);
    if (first && first.isSymbolicLink()) await unlink(path);
    const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(content, "utf8");
      try {
        await handle.chmod(0o700);
      } catch (error) {
        console.warn(
          `[acp-host] ${key} could not lock ${path} owner-only: ${(error as Error).message}`
        );
      }
      if (uid !== undefined && gid !== undefined) {
        try {
          await handle.chown(uid, gid);
        } catch (error) {
          console.warn(
            `[acp-host] ${key} could not hand ${path} to its owner: ${(error as Error).message}`
          );
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
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
    try {
      unlinkSync(this.execRecordPath(key, execId));
    } catch {
      /* never written, finished already, or the reaper took it */
    }
    if (bySession.size === 0) this.execs.delete(key);
  }

  /** Where one build's restart-proof deadline lives. */
  private execRecordPath(key: string, execId: number): string {
    return join(this.deps.neutralBase, key, "acp-exec", `${execId}.json`);
  }

  /**
   * Persist one build's deadline. Skipped when the child has no process id
   * (injected test doubles): there is nothing a restarted runner could stop.
   */
  private async writeExecRecord(
    key: string,
    execId: number,
    record: Omit<ExecDeadlineRecord, "pid"> & { pid: number | undefined }
  ): Promise<void> {
    if (record.pid === undefined) return;
    const path = this.execRecordPath(key, execId);
    const { pid, ...rest } = record;
    await mkdir(join(this.deps.neutralBase, key, "acp-exec"), { recursive: true });
    const handle = await open(path, O_WRONLY | O_CREAT | O_TRUNC, 0o600);
    try {
      await handle.writeFile(JSON.stringify({ pid, ...rest }), "utf8");
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** Read one deadline record; null when it is missing or not what we wrote. */
  private async readExecRecord(path: string): Promise<ExecDeadlineRecord | null> {
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
        startedAt: typeof raw.startedAt === "number" ? raw.startedAt : 0
      };
    } catch {
      return null;
    }
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
