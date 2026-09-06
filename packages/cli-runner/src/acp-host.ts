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
}

export interface AcpReadResult {
  readonly lines: readonly string[];
  readonly nextSeq: number;
  readonly exited: boolean;
  readonly exitCode: number | null;
}

/** Buffered stdout lines per session; the API drains them with a sequence cursor. */
const MAX_BUFFERED_LINES = 500;
/** Idle sessions are reaped on the next call so a dead API cannot leak agents. */
const IDLE_REAP_MS = 30 * 60 * 1000;
/** Single-line cap: a pathological stdout line must not blow the RPC frame cap. */
const MAX_LINE_BYTES = 256 * 1024;

interface AcpSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  buffered: string[];
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  lastActivity: number;
}

function defaultResolveAdapterEntry(): string {
  return createRequire(import.meta.url).resolve("@zed-industries/claude-code-acp/dist/index.js");
}

export class AcpHost {
  private readonly sessions = new Map<string, AcpSession>();

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
      await chown(sessionDir, uid, gid).catch(() => undefined);
      await chmod(sessionDir, 0o700).catch(() => undefined);
    }

    // Project settings the adapter honors: the agent sees this folder. Written
    // before spawn so the first session already runs scoped.
    const settingsDir = join(sessionDir, ".Muse");
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({ permissions: { additionalDirectories: [sessionDir] } })
    );
    if (uid !== undefined && gid !== undefined) {
      await chown(settingsDir, uid, gid).catch(() => undefined);
      await chown(settingsPath, uid, gid).catch(() => undefined);
    }

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
        spawn(process.execPath, [opts.entry], {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"],
          ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
          ...(opts.gid !== undefined ? { gid: opts.gid } : {})
        }) as ChildProcessWithoutNullStreams);
    const child = spawnChild({ entry, cwd: sessionDir, env, uid, gid });

    const session: AcpSession = {
      child,
      cwd: sessionDir,
      buffered: [],
      nextSeq: 0,
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
        session.nextSeq += 1;
        if (session.buffered.length > MAX_BUFFERED_LINES) {
          session.buffered.splice(0, session.buffered.length - MAX_BUFFERED_LINES);
        }
      }
      session.lastActivity = Date.now();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      // Adapter diagnostics ride stderr by design (stdout is protocol). Keep the
      // tail in the runner log, truncated, never the full stream.
      const text = chunk.toString("utf8").slice(-2000);
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
    return { cwd: sessionDir };
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
    const lines =
      afterSeq < start ? [...session.buffered] : session.buffered.slice(afterSeq - start);
    session.lastActivity = Date.now();
    return { lines, nextSeq: session.nextSeq, exited: session.exited, exitCode: session.exitCode };
  }

  kill(sessionKey: string): void {
    this.sweepIdle();
    const key = sanitizeSessionKey(sessionKey);
    if (!this.sessions.has(key)) return;
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
