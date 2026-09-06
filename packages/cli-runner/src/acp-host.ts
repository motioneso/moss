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
import { chmod, chown, mkdir, readFile, writeFile } from "node:fs/promises";
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
