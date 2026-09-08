/**
 * AcpHost — spawns a provider's ACP adapter as the session user and pipes its
 * stdio lines for the API-side client in `@moss/acp` (slice 1, chat first).
 *
 * The runner is deliberately a dumb line pipe: it never parses ACP JSON. Spawning
 * mirrors the chat engine topology (sanitized env, per-user UID when enabled, HOME at
 * the shared home base, per-session working folder), and the vendor login reaches the
 * child through its environment, never the command line. Which adapter runs comes
 * from the spawn's provider kind, resolved to that row's pinned registry entry;
 * a spawn without a kind is refused — there is no default provider anywhere.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AcpExecManager,
  ACP_EXEC_OUTPUT_CAP_BYTES,
  ACP_EXEC_DEFAULT_TIMEOUT_MS,
  ACP_EXEC_MAX_TIMEOUT_MS,
  MAX_EXECS_PER_SESSION,
  MAX_EXECS_TOTAL,
  type AcpExecStartResult,
  type AcpExecPollResult
} from "./acp-execs.js";
import {
  prepareOwnedPathWithOwnership,
  writeOpencodeChatDenyFile,
  type OwnershipApplier
} from "./owned-fs.js";
import { buildSetprivDropCommand } from "./setpriv.js";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { allocateUidSlot } from "./uid-allocator.js";
import { providerTokenPath } from "./provider-token-store.js";
import {
  getAcpProviderRow,
  launchOffList,
  lookupAcpToolFamily,
  type AcpProfile,
  type AcpProviderKind
} from "@moss/acp";
import { redactSecrets } from "@moss/ai";
import { sanitizeSessionKey } from "@moss/chat/live";

// Re-exported so callers that only know acp-host.ts keep working unchanged;
// the definitions live in acp-execs.ts (task 5b, 2026-09-08 file-size split).
export {
  ACP_EXEC_OUTPUT_CAP_BYTES,
  ACP_EXEC_DEFAULT_TIMEOUT_MS,
  ACP_EXEC_MAX_TIMEOUT_MS,
  MAX_EXECS_PER_SESSION,
  MAX_EXECS_TOTAL
};
export type { AcpExecStartResult, AcpExecPollResult };

export interface AcpHostDeps {
  readonly neutralBase: string;
  readonly homeBase?: string;
  /** Mirrors the engine host flag: setuid spawn only with a root container. */
  readonly perUserUid?: boolean;
  /** Hands a folder/file to its owner; injected so tests can prove routing without real
   * chown privileges. Prod default really calls chown; the failure-and-cleanup behavior
   * itself is proved separately in cli-runner-owned-fs.test.ts against an unreachable id. */
  readonly applyOwnership?: OwnershipApplier;
  /** Resolves the adapter spawn target; injected so tests never touch node_modules. */
  readonly resolveAdapterTarget?: (kind: AcpProviderKind) => AcpAdapterTarget;
  /** Reads a file; injected so tests can stub the login token. */
  readonly readTokenFile?: (path: string) => Promise<string>;
  /**
   * Spawns the adapter child; injected so tests never start a process. The
   * production default runs the resolved target (node plus the adapter entry,
   * or the provider's binary) with piped stdio under the session identity.
   */
  readonly spawnChild?: (opts: {
    command: string;
    args: string[];
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
  /**
   * The spawned agent's own process id. setpriv execs into the target rather
   * than forking, so this is the real agent process, not a wrapper — a caller
   * can read `/proc/<pid>/status` on it for genuine identity evidence (task
   * 5b, Astra-Reviewer finding 5b, 2026-09-08), instead of trusting a folder
   * owner stat that only shows what was asked for.
   */
  readonly pid: number | null;
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

/** What runs for one adapter spawn: node plus the row's pinned entry, or the provider binary. */
export interface AcpAdapterTarget {
  readonly command: string;
  readonly args: string[];
}

/** Node-spawnable adapter entries by provider kind, from the pinned registry packages. */
const ADAPTER_ENTRY_PACKAGES = {
  anthropic: "@agentclientprotocol/claude-agent-acp/dist/index.js",
  openai: "@agentclientprotocol/codex-acp/dist/index.js"
} as const;

/** Resolve the spawn target for a provider kind; unknown kinds are refused by the row lookup. */
export function defaultResolveAdapterTarget(kind: AcpProviderKind): AcpAdapterTarget {
  getAcpProviderRow(kind);
  if (kind === "opencode") {
    // Pinned package launcher (postinstall places the platform binary there).
    const packageJson = createRequire(import.meta.url).resolve("opencode-ai/package.json");
    return { command: join(dirname(packageJson), "bin", "opencode.exe"), args: ["acp"] };
  }
  const entry = ADAPTER_ENTRY_PACKAGES[kind as keyof typeof ADAPTER_ENTRY_PACKAGES];
  if (!entry) throw new Error(`No adapter package installed for provider kind: ${kind}`);
  return {
    command: process.execPath,
    args: [createRequire(import.meta.url).resolve(entry)]
  };
}

/**
 * A process's actual start time in system ticks, read from the system process
 * table. Compared against the start time saved when the build was started:
 * only the same build is ever stopped. Null when the process is gone or the
 * table cannot be read — never a reason to kill.
 */
export class AcpHost {
  private readonly sessions = new Map<string, AcpSession>();
  private generationCounter = 0;
  private readonly execManager: AcpExecManager;

  constructor(private readonly deps: AcpHostDeps) {
    // No sweep here: the constructor cannot wait, and an unwaited sweep
    // races the startup clean-out over the same folder. The engine runs the
    // sweep after its clean-out, and every build start runs it as a backstop.
    this.execManager = new AcpExecManager(deps);
  }

  /**
   * Stop builds that outlived the runner process that started them. Delegates
   * to the exec manager (acp-execs.ts); see there for the full contract. Safe
   * to call any number of times. Must run after the startup clean-out, never
   * beside it.
   */
  async reapOrphanedExecs(): Promise<void> {
    await this.execManager.reapOrphanedExecs();
  }

  /**
   * Start one provider's agent as the session user and hand back the pipe.
   * Kind, user and profile are all required and undefaulted; the launch
   * follows the selected row (per-person slot and home, per-row login and
   * off-list).
   */
  async spawn(
    sessionKey: string,
    projectId: string,
    providerKind: AcpProviderKind,
    userId: string,
    profile: AcpProfile
  ): Promise<AcpSpawnResult> {
    if (!providerKind) throw new Error("acpSpawn.providerKind is required: no default provider");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(projectId)) {
      throw new Error("acpSpawn.projectId must match [A-Za-z0-9_-]{1,64}");
    }
    if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
      throw new Error("acpSpawn.userId must match [A-Za-z0-9_-]{1,64}");
    }
    if (profile !== "chat" && profile !== "workshop")
      throw new Error("acpSpawn.profile must be chat or workshop");
    // A row marked not ready refuses here, whoever asks: the launcher is the
    // only piece that knows the home has no login, and later unattended
    // callers come through it directly. Before any side effect, so a refused
    // spawn allocates no slot, kills no prior session and writes no file.
    if (profile === "chat") {
      const row = getAcpProviderRow(providerKind);
      if (!row.chatReady) {
        throw new Error(`Not logged in (${row.chatBlockReason ?? "provider not ready"})`);
      }
    }
    const key = sanitizeSessionKey(sessionKey);
    this.killRecord(key);

    // Per-user identity is mandatory on this path: without it every agent
    // would share one account and one home, and the deny file would land in
    // a shared folder. Refuse rather than fall back.
    if (!this.deps.perUserUid || !this.deps.homeBase) {
      throw new Error("acpSpawn requires per-user identity: refusing the shared home");
    }

    // One slot per person, never per conversation.
    const slot = allocateUidSlot(this.deps.homeBase, userId);
    const uid = slot.uid;
    const gid = slot.gid;
    // The slot's own home, never the shared base: two people must not read
    // each other's logins.
    const agentHome = await prepareOwnedPathWithOwnership(
      this.deps.homeBase,
      userId,
      uid,
      gid,
      ["agents", userId],
      this.deps.applyOwnership,
      // "agents" is a shared parent the launcher itself keeps owning
      // (pass-through, 0711); only "userId" below it hands over owner-only
      // (task 5b, Astra-Reviewer finding 3, 2026-09-08).
      1
    );
    // Same link-safe folder setup the build path uses, at every level: a
    // command that ran here earlier can plant a link at this folder or any of
    // its parents, so each level is cleared of links and verified before the
    // next builds on it. Owner-only whatever the identity option says: with
    // it off every session shares one account, so this narrows nothing
    // between people — the real containment there is the disabled built-ins
    // plus the per-session folder (asserted in cli-runner-acp-host.test.ts),
    // not these bits. Still the only safe default: group and world get
    // nothing.
    const sessionDir = await prepareOwnedPathWithOwnership(
      this.deps.neutralBase,
      key,
      uid,
      gid,
      [key, "acp", projectId],
      this.deps.applyOwnership
    );

    const env: NodeJS.ProcessEnv = {
      ...buildSanitizedCliEnv(process.env),
      HOME: agentHome
    };
    // The login travels only the way the selected row needs it, via the
    // environment only. Claude reads the stored token; Codex reuses the
    // on-disk login in the agent home; OpenCode gets neither.
    if (providerKind === "anthropic") {
      const token = await this.readLoginToken(this.deps.homeBase);
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }
    // The row's launch-time off-list from the table through the row's own
    // mechanism. Codex runs read-only exactly when the profile switches
    // shell off; OpenCode's deny file lands in the agent home for chat,
    // never Workshop.
    if (
      providerKind === "openai" &&
      launchOffList(profile).some((name) => lookupAcpToolFamily(name) === "shell")
    ) {
      env.INITIAL_AGENT_MODE = "read-only";
    }
    if (providerKind === "opencode" && profile === "chat") {
      await writeOpencodeChatDenyFile(agentHome, userId, uid, gid, this.deps.applyOwnership);
    }

    const target =
      this.deps.resolveAdapterTarget?.(providerKind) ?? defaultResolveAdapterTarget(providerKind);
    const spawnChild =
      this.deps.spawnChild ??
      ((opts) => {
        // The launcher itself now carries ambient capabilities (task 5b) that
        // would otherwise pass straight through a plain account switch to
        // every agent it starts, handing each one the power to switch to any
        // account. setpriv both switches to the person's own slot and drops
        // every inheritable/ambient capability on the way, so the spawned
        // process ends with none (Astra-Reviewer finding 2, 2026-09-08). The
        // outer spawn then runs as the launcher's own identity, not the
        // target uid/gid — setpriv performs that switch itself.
        const launch =
          opts.uid !== undefined && opts.gid !== undefined
            ? buildSetprivDropCommand(opts.command, opts.args, { uid: opts.uid, gid: opts.gid })
            : { command: opts.command, args: [...opts.args] };
        // detached: the adapter owns a process group, so kill takes down the
        // whole tree (the agent SDK's own CLI grandchild included) — a plain
        // child.kill would orphan it. Same shape as the persistent chat runtime.
        return spawn(launch.command, launch.args, {
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"],
          detached: true
        }) as ChildProcessWithoutNullStreams;
      });
    const child = spawnChild({
      command: target.command,
      args: target.args,
      cwd: sessionDir,
      env,
      uid,
      gid
    });

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
    // the agent runs without a home.
    return {
      cwd: sessionDir,
      generation: session.generation,
      home: agentHome,
      pid: child.pid ?? null
    };
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
   * its id. Delegates to the exec manager (acp-execs.ts); see there for the
   * full contract.
   */
  async execStart(
    sessionKey: string,
    projectId: string,
    command: string,
    timeoutMs: number = ACP_EXEC_DEFAULT_TIMEOUT_MS
  ): Promise<AcpExecStartResult> {
    return this.execManager.execStart(sessionKey, projectId, command, timeoutMs);
  }

  execPoll(sessionKey: string, execId: number): AcpExecPollResult {
    return this.execManager.execPoll(sessionKey, execId);
  }

  execKill(sessionKey: string, execId: number): void {
    this.execManager.execKill(sessionKey, execId);
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
