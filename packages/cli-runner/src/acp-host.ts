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
import { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } from "node:constants";
import { createRequire } from "node:module";
import { chmod, chown, lstat, mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
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
const MAX_EXECS_PER_SESSION = 32;

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

  constructor(private readonly deps: AcpHostDeps) {}

  async spawn(sessionKey: string, projectId: string): Promise<AcpSpawnResult> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new Error("acpSpawn.projectId must match [A-Za-z0-9_-]{1,64}");
    }
    const key = sanitizeSessionKey(sessionKey);
    this.killRecord(key);

    const sessionDir = join(this.deps.neutralBase, key, "acp", projectId);
    await mkdir(sessionDir, { recursive: true });

    let uid: number | undefined;
    let gid: number | undefined;
    if (this.deps.perUserUid && this.deps.homeBase) {
      const slot = allocateUidSlot(this.deps.homeBase, key);
      uid = slot.uid;
      gid = slot.gid;
      await this.chownOwned(key, sessionDir, uid, gid);
    }
    // Owner-only whatever the identity option says: with it off every session
    // shares one account, so this narrows nothing between people — the real
    // containment there is the disabled built-ins plus the per-session folder
    // (asserted in cli-runner-acp-host.test.ts), not these bits. Still the only
    // safe default: group and world get nothing.
    await this.chmodOwned(key, sessionDir);

    // Project settings at the path the adapter actually reads
    // (<cwd>/.claude/settings.json). A bare tool name denies every use of it,
    // so even an adapter that ignored the disabled-built-ins flag could neither
    // shell out nor write. Written before spawn so the first session is scoped.
    const settingsDir = join(sessionDir, ".claude");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { deny: ["Bash", "Write", "Edit", "NotebookEdit"] } })
    );
    if (uid !== undefined && gid !== undefined) {
      await this.chownOwned(key, settingsDir, uid, gid);
      await this.chownOwned(key, settingsPath, uid, gid);
    }
    await this.chmodOwned(key, settingsDir);
    await this.chmodOwned(key, settingsPath);

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
    return { cwd: sessionDir, generation: session.generation };
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
   * killed and the poll reply carries whatever ran so far.
   */
  async execStart(
    sessionKey: string,
    projectId: string,
    command: string,
    timeoutMs: number = ACP_EXEC_DEFAULT_TIMEOUT_MS
  ): Promise<AcpExecStartResult> {
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
    // The build's own home, inside its own scratch area — never the shared
    // home base, so the login token file and anything else under the shared
    // home are simply not there for the command to read.
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

    // Scrubbed environment with the build's own home. The vendor login reaches
    // the child in neither the environment nor the home folder.
    const env: NodeJS.ProcessEnv = {
      ...buildSanitizedCliEnv(process.env),
      HOME: homeDir
    };
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
    const bySession = this.execs.get(key) ?? new Map<number, AcpExec>();
    if (bySession.size >= MAX_EXECS_PER_SESSION) {
      const oldestDone = [...bySession.values()].find((record) => record.done);
      if (!oldestDone) throw new Error("acpExecStart: too many running commands for this session");
      this.dropExec(key, bySession, oldestDone.id);
    }
    const id = (this.execCounter += 1);
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
      throw new Error("acpExecStart: project folder is not a folder");
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
   * Owner-only bits, always. A failure is said out loud: silent best-effort is
   * how isolation ends up missing with nobody knowing.
   */
  private async chmodOwned(key: string, path: string): Promise<void> {
    try {
      await chmod(path, 0o700);
    } catch (error) {
      console.warn(
        `[acp-host] ${key} could not lock ${path} owner-only: ${(error as Error).message}`
      );
    }
  }

  private async chownOwned(key: string, path: string, uid: number, gid: number): Promise<void> {
    try {
      await chown(path, uid, gid);
    } catch (error) {
      console.warn(
        `[acp-host] ${key} could not hand ${path} to its owner: ${(error as Error).message}`
      );
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
    if (bySession.size === 0) this.execs.delete(key);
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
