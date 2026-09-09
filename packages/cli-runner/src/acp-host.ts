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
import { readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AcpExecManager,
  ACP_EXEC_OUTPUT_CAP_BYTES,
  ACP_EXEC_DEFAULT_TIMEOUT_MS,
  ACP_EXEC_MAX_TIMEOUT_MS,
  MAX_EXECS_PER_SESSION,
  MAX_EXECS_TOTAL,
  readProcStartTime,
  type AcpExecStartResult,
  type AcpExecPollResult
} from "./acp-execs.js";
import {
  ensureOwnedTopLevel,
  prepareOwnedPathWithOwnership,
  type OwnershipApplier
} from "./owned-fs.js";
import {
  listAcpPrivateMarkerKeys,
  readAcpPrivateMarker,
  removeAcpPrivateMarker,
  writeAcpPrivateMarker,
  type AcpPrivateMarkerRecord
} from "./acp-private-markers.js";
import { buildSetprivDropCommand } from "./setpriv.js";

import { buildSanitizedCliEnv } from "./sanitized-env.js";
import { allocateUidSlot as defaultAllocateUidSlot } from "./uid-allocator.js";
import { providerTokenPath } from "./provider-token-store.js";
import {
  getAcpProviderRow,
  launchOffList,
  lookupAcpToolFamily,
  opencodeDenyPermissionKeys,
  type AcpProfile,
  type AcpProviderKind
} from "@moss/acp";
import { redactSecrets, transcriptGlobDir } from "@moss/ai";
import { sanitizeSessionKey } from "@moss/chat/live";

/** A provider's own transcript store outside the scratch folder, or null if none is known. */
function acpProviderTranscriptDir(
  provider: AcpProviderKind,
  cwd: string,
  home: string
): string | null {
  switch (provider) {
    case "anthropic":
      return transcriptGlobDir("anthropic", cwd, home);
    case "openai":
      return transcriptGlobDir("openai-compatible", cwd, home);
    default:
      return null;
  }
}

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
  /** Runs the home/session preparation step as the person's own slot; injected so tests never shell out. */
  readonly runAgentHomePrepare?: (
    request: AgentHomePrepareRequest,
    identity: { uid: number; gid: number }
  ) => Promise<void>;
  /**
   * Overrides the real per-person uid/gid slot allocator. Injected only so
   * tests can prove folder reuse against a genuinely reachable identity (their
   * own real uid/gid, which unprivileged chown always accepts) without
   * needing real root. Production always uses the default.
   */
  readonly allocateUidSlot?: (homeBase: string, userId: string) => { uid: number; gid: number };
  /** Deletes a private folder as its owning account; injected so tests never shell out to setpriv. */
  readonly purgePrivateFolder?: (
    cwd: string,
    identity: { readonly uid: number; readonly gid: number } | null
  ) => Promise<void>;
}

/** Argument passed as one JSON string to agent-home-prepare.mjs. */
export interface AgentHomePrepareRequest {
  readonly dirs: readonly string[];
  readonly denyFile: { readonly path: string; readonly permissionKeys: readonly string[] } | null;
}

export interface AcpSpawnResult {
  readonly cwd: string;
  readonly generation: number;
  /** The HOME handed to the agent process, or null when it names none. */
  readonly home: string | null;
  /** The spawned agent's own process id (setpriv execs into it, so it's the real process). */
  readonly pid: number | null;
  /** The slot account the agent runs as — the expected identity to check /proc/<pid>/status against. */
  readonly uid: number;
  readonly gid: number;
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
/** How long a stop waits for the signalled process to actually exit before reporting it as refused. */
const KILL_CONFIRM_TIMEOUT_MS = 5000;

interface AcpSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly cwd: string;
  readonly generation: number;
  /**
   * The chat profile's working folder is an empty scratch folder that must
   * not survive past this session (spec: 2026-09-06-acp-client-design.md);
   * workshop's is the person's real project folder and is never purged.
   * killRecord reads this to decide whether to purge on the way out.
   */
  readonly profile: AcpProfile;
  /** HOME handed to the agent process — where its own CLI may keep a transcript outside cwd. */
  readonly home: string;
  readonly providerKind: AcpProviderKind;
  /**
   * The slot's own identity, present whenever per-user separation launched
   * this session. The launcher's three privileges (chown/setuid/setgid) do
   * not include signalling another account's process, so a stop is sent
   * through setpriv running as this identity instead (task 5b, Astra-Reviewer
   * finding 3, 2026-09-08). Null only for a session launched without
   * per-user identity.
   */
  readonly identity: { readonly uid: number; readonly gid: number } | null;
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
  /**
   * Set once a stop signal is in flight for this session, so an idle sweep or
   * a second kill call while it is confirming does not send the signal twice.
   * Cleared again if the stop fails, so a later call can retry.
   */
  stopping: boolean;
  /**
   * The in-flight stop's own promise, so a concurrent caller awaits and
   * relays the SAME outcome instead of returning success immediately while
   * the first stop is still running (task 5b, Astra-Reviewer round-four
   * finding: a concurrent close returned success while the process was
   * still alive, 2026-09-08). Cleared alongside `stopping`.
   */
  stopPromise: Promise<void> | undefined;
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
 * Run the below-top-level preparation step as the person's own slot: setpriv
 * switches identity, then the runner's own Node binary runs the script,
 * given the request as one JSON argv element (never through a shell, so
 * nothing in it is ever interpolated). A non-zero exit fails the launch with
 * the step's own stderr (task 5b, Architect ruling, 2026-09-08).
 */
async function defaultRunAgentHomePrepare(
  request: AgentHomePrepareRequest,
  identity: { uid: number; gid: number }
): Promise<void> {
  const script = createRequire(import.meta.url).resolve("./agent-home-prepare.mjs");
  const { command, args } = buildSetprivDropCommand(
    process.execPath,
    [script, JSON.stringify(request)],
    identity
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: buildSanitizedCliEnv(process.env)
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => reject(error));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `AcpHost: could not prepare the agent's home: ${stderr.trim() || `exit code ${String(code)}`}`
          )
        );
    });
  });
}

/**
 * Delete a chat-profile working folder as its owning account, the same
 * setpriv-drop path signalProcessGroup uses to stop the process. Node's own
 * binary does the removal (`-e`, an fs call) so no external `rm` program
 * needs to exist in the image, matching the kill signal's own approach.
 * The folder path travels through an env var, never interpolated into a
 * script string.
 */
async function defaultPurgePrivateFolder(
  cwd: string,
  identity: { readonly uid: number; readonly gid: number } | null
): Promise<void> {
  if (!identity) {
    await rm(cwd, { recursive: true, force: true });
    return;
  }
  const { command, args } = buildSetprivDropCommand(
    process.execPath,
    ["-e", "require('node:fs').rmSync(process.env.ACP_PURGE_DIR,{recursive:true,force:true})"],
    identity
  );
  await new Promise<void>((resolve, reject) => {
    const purger = spawn(command, args, {
      stdio: "ignore",
      env: { ...buildSanitizedCliEnv(process.env), ACP_PURGE_DIR: cwd }
    });
    purger.once("error", reject);
    purger.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`purge for ${cwd} exited with code ${String(code)}`));
    });
  });
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
    await this.killRecord(key);

    // Per-user identity is mandatory on this path: without it every agent
    // would share one account and one home, and the deny file would land in
    // a shared folder. Refuse rather than fall back.
    const homeBase = this.deps.homeBase;
    if (!this.deps.perUserUid || !homeBase) {
      throw new Error("acpSpawn requires per-user identity: refusing the shared home");
    }

    // One slot per person, never per conversation.
    const allocate = this.deps.allocateUidSlot ?? defaultAllocateUidSlot;
    const slot = allocate(this.deps.homeBase, userId);
    const uid = slot.uid;
    const gid = slot.gid;

    // The launcher's own folder work stops at each person's top level: the
    // slot's home folder, and the conversation's session-key folder. A
    // returning person's top level already exists and is already theirs, so
    // the launcher only checks the kernel's record of it — it must never try
    // to open a folder that belongs to someone else (task 5b, Architect
    // ruling on Astra-Reviewer round-four finding, 2026-09-08 — the old code
    // tried to recreate/re-enter the whole tree on every launch and refused
    // a second launch for the same person once their home was owner-only).
    const setup = await (async () => {
      let agentHomeTop: Awaited<ReturnType<typeof ensureOwnedTopLevel>> | undefined;
      let sessionTop: Awaited<ReturnType<typeof ensureOwnedTopLevel>> | undefined;
      try {
        const agentsParent = (await prepareOwnedPathWithOwnership(homeBase, userId, ["agents"], 1))
          .path;
        agentHomeTop = await ensureOwnedTopLevel(
          userId,
          agentsParent,
          userId,
          uid,
          gid,
          this.deps.applyOwnership
        );
        const agentHome = agentHomeTop.path;
        sessionTop = await ensureOwnedTopLevel(
          key,
          this.deps.neutralBase,
          key,
          uid,
          gid,
          this.deps.applyOwnership
        );
        const sessionDir = join(sessionTop.path, "acp", projectId);

        const env: NodeJS.ProcessEnv = {
          ...buildSanitizedCliEnv(process.env),
          HOME: agentHome
        };
        if (providerKind === "anthropic") {
          const token = await this.readLoginToken(homeBase);
          if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
        }
        if (
          providerKind === "openai" &&
          launchOffList(profile).some((name) => lookupAcpToolFamily(name) === "shell")
        ) {
          env.INITIAL_AGENT_MODE = "read-only";
        }

        const denyFile =
          providerKind === "opencode" && profile === "chat"
            ? {
                path: join(agentHome, ".config", "opencode", "opencode.json"),
                permissionKeys: [...opencodeDenyPermissionKeys()]
              }
            : null;
        const prepareDirs = [sessionDir];
        if (denyFile) prepareDirs.push(join(agentHome, ".config", "opencode"));
        const runAgentHomePrepare = this.deps.runAgentHomePrepare ?? defaultRunAgentHomePrepare;
        await runAgentHomePrepare({ dirs: prepareDirs, denyFile }, { uid, gid });
        return { agentHome, sessionDir, env };
      } catch (error) {
        if (agentHomeTop?.createdHere) {
          await rm(agentHomeTop.path, { force: true, recursive: true }).catch(() => undefined);
        }
        if (sessionTop?.createdHere) {
          await rm(sessionTop.path, { force: true, recursive: true }).catch(() => undefined);
        }
        throw error;
      }
    })();
    const { agentHome, sessionDir, env } = setup;

    // Written before the child exists (fail-closed); pid/startTime backfilled below.
    const chatMarkerRecord: AcpPrivateMarkerRecord | null =
      profile === "chat"
        ? {
            sessionKey: key,
            cwd: sessionDir,
            home: agentHome,
            uid,
            gid,
            provider: providerKind,
            pid: null,
            startTime: null
          }
        : null;
    if (chatMarkerRecord) {
      await writeAcpPrivateMarker(this.deps.neutralBase, key, chatMarkerRecord);
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
        //
        // The working directory is entered after the identity switch, never
        // by this outer spawn's own cwd option: by now the session folder has
        // already been handed over to the target account, and the launcher
        // can no longer enter a folder it does not own (task 5b,
        // Astra-Reviewer finding 2, 2026-09-08). setpriv itself has no cd
        // step, so the privileged path wraps the real command in a shell that
        // cd's after setpriv has already switched identity and is about to
        // exec it; the folder name travels as its own argument, never
        // interpolated into the script text.
        const launch =
          opts.uid !== undefined && opts.gid !== undefined
            ? buildSetprivDropCommand(
                "sh",
                ["-c", 'cd "$1" && shift && exec "$@"', "sh", opts.cwd, opts.command, ...opts.args],
                { uid: opts.uid, gid: opts.gid }
              )
            : { command: opts.command, args: [...opts.args] };
        // detached: the adapter owns a process group, so kill takes down the
        // whole tree (the agent SDK's own CLI grandchild included) — a plain
        // child.kill would orphan it. Same shape as the persistent chat runtime.
        return spawn(launch.command, launch.args, {
          // No cwd here for the privileged path — see above. The
          // non-privileged fallback (uid/gid undefined, tests only) keeps
          // entering the folder directly, since there is no identity switch
          // to wait for.
          cwd: opts.uid !== undefined && opts.gid !== undefined ? undefined : opts.cwd,
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

    // Records the process a boot sweep must confirm has stopped before purging.
    if (chatMarkerRecord && typeof child.pid === "number") {
      await writeAcpPrivateMarker(this.deps.neutralBase, key, {
        ...chatMarkerRecord,
        pid: child.pid,
        startTime: readProcStartTime(child.pid)
      });
    }

    const session: AcpSession = {
      child,
      cwd: sessionDir,
      identity: { uid, gid },
      profile,
      home: agentHome,
      providerKind,
      generation: (this.generationCounter += 1),
      buffered: [],
      bufferedBytes: 0,
      nextSeq: 0,
      deliveredSeq: 0,
      truncated: false,
      exited: false,
      exitCode: null,
      lastActivity: Date.now(),
      stopping: false,
      stopPromise: undefined
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
      pid: child.pid ?? null,
      uid,
      gid
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

  async kill(sessionKey: string, expectedGeneration?: number): Promise<void> {
    this.sweepIdle();
    const key = sanitizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) return;
    // A guarded kill from a dropped connection must not take down a session
    // another connection respawned after it: generations differ, so no-op.
    if (expectedGeneration !== undefined && session.generation !== expectedGeneration) return;
    await this.killRecord(key);
  }

  private requireLive(sessionKey: string): AcpSession {
    const key = sanitizeSessionKey(sessionKey);
    const session = this.sessions.get(key);
    if (!session) throw new Error("ACP session is not running");
    if (session.exited) throw new Error("ACP session has exited");
    return session;
  }

  /**
   * Stop one session's process group and wait for it to actually exit before
   * dropping the record for it. The launcher's three privileges (chown,
   * setuid, setgid) do not cover signalling another account's process, so
   * a session launched under a slot identity is stopped through setpriv
   * running AS that same slot, which needs no further privilege to signal
   * its own process group. A refused or unconfirmed stop is thrown, not
   * swallowed, and the session record is kept so the caller can retry
   * (task 5b, Astra-Reviewer finding 3, 2026-09-08).
   *
   * A caller that arrives while a stop is already in flight awaits and
   * relays that SAME stop's outcome, rather than returning success right
   * away while the process is still alive — the earlier version did the
   * latter, so a concurrent close reported the session gone before it
   * actually was (task 5b, Astra-Reviewer round-four finding, 2026-09-08).
   */
  private async killRecord(key: string): Promise<void> {
    const session = this.sessions.get(key);
    if (!session) return;
    if (session.exited) {
      await this.purgeIfChatProfile(key, session);
      this.sessions.delete(key);
      return;
    }
    if (session.stopping) {
      await session.stopPromise;
      return;
    }
    const pid = session.child.pid;
    if (pid === undefined) {
      await this.purgeIfChatProfile(key, session);
      this.sessions.delete(key);
      return;
    }
    session.stopping = true;
    const stopPromise = (async () => {
      await this.signalProcessGroup(session, pid);
      await this.awaitExit(session);
    })();
    session.stopPromise = stopPromise;
    try {
      await stopPromise;
    } catch (error) {
      session.stopping = false;
      session.stopPromise = undefined;
      throw error;
    }
    await this.purgeIfChatProfile(key, session);
    this.sessions.delete(key);
  }

  /**
   * The chat profile's scratch working folder is purged as its owning
   * account the moment the process is confirmed stopped — the marker
   * written at spawn is removed only once that purge succeeds, so a refused
   * purge is retried by the next boot sweep instead of silently forgotten
   * (spec: a folder the sweep cannot enter never counts as cleaned). Never
   * throws: a purge failure here must not block the kill itself.
   */
  private async purgeIfChatProfile(key: string, session: AcpSession): Promise<void> {
    if (session.profile !== "chat") return;
    try {
      await this.purgePrivateWorkingFolder(session.cwd, session.identity);
      const transcriptDir = acpProviderTranscriptDir(
        session.providerKind,
        session.cwd,
        session.home
      );
      if (transcriptDir) {
        await this.purgePrivateWorkingFolder(transcriptDir, session.identity);
      }
      await removeAcpPrivateMarker(this.deps.neutralBase, key);
    } catch (error) {
      console.error(
        `[acp-host] ${key} could not purge its private working folder, leaving the marker for the boot sweep: ${(error as Error).message}`
      );
    }
  }

  /**
   * Delete a chat-profile working folder as its owning account. Runs the
   * injected `deps.purgePrivateFolder` when a test supplies one, else the
   * real setpriv-drop path.
   */
  private async purgePrivateWorkingFolder(
    cwd: string,
    identity: { readonly uid: number; readonly gid: number } | null
  ): Promise<void> {
    const purge = this.deps.purgePrivateFolder ?? defaultPurgePrivateFolder;
    await purge(cwd, identity);
  }

  /** Boot-time recovery: stop and purge every folder a leftover marker names. */
  async sweepPrivateMarkers(): Promise<boolean> {
    let keys: string[];
    try {
      keys = await listAcpPrivateMarkerKeys(this.deps.neutralBase);
    } catch (error) {
      console.error(
        `[acp-host] boot sweep could not list private markers, none can be checked this run: ${(error as Error).message}`
      );
      return false;
    }
    let allPurged = true;
    for (const key of keys) {
      const read = await readAcpPrivateMarker(this.deps.neutralBase, key);
      if (read.status === "missing") {
        await removeAcpPrivateMarker(this.deps.neutralBase, key);
        continue;
      }
      if (read.status === "invalid") {
        allPurged = false;
        console.error(
          `[acp-host] boot sweep found an unreadable private marker for ${key}, leaving it`
        );
        continue;
      }
      const record = read.record;
      const identity = { uid: record.uid, gid: record.gid };
      try {
        if (record.pid !== null && record.startTime !== null) {
          const stopped = await this.confirmStoppedOrStop(record.pid, record.startTime, identity);
          if (!stopped) {
            throw new Error(
              `process ${record.pid} for ${key} did not stop in time, refusing to purge`
            );
          }
        }
        await this.purgePrivateWorkingFolder(record.cwd, identity);
        const transcriptDir = acpProviderTranscriptDir(record.provider, record.cwd, record.home);
        if (transcriptDir) {
          await this.purgePrivateWorkingFolder(transcriptDir, identity);
        }
        await removeAcpPrivateMarker(this.deps.neutralBase, key);
      } catch (error) {
        allPurged = false;
        console.error(
          `[acp-host] boot sweep could not purge ${record.cwd} for ${key}, leaving the marker: ${(error as Error).message}`
        );
      }
    }
    return allPurged;
  }

  /**
   * Confirms the pid is the recorded process, stops it, and polls for exit.
   * A start-time mismatch means it already exited or was recycled, so
   * purging is already safe. False means still running after the timeout.
   */
  private async confirmStoppedOrStop(
    pid: number,
    recordedStartTime: string,
    identity: { readonly uid: number; readonly gid: number }
  ): Promise<boolean> {
    if (readProcStartTime(pid) !== recordedStartTime) return true;
    const { command, args } = buildSetprivDropCommand(
      process.execPath,
      ["-e", "process.kill(-Number(process.env.ACP_STOP_PID), 'SIGTERM')"],
      identity
    );
    await new Promise<void>((resolve, reject) => {
      const stopper = spawn(command, args, {
        stdio: "ignore",
        env: { ...buildSanitizedCliEnv(process.env), ACP_STOP_PID: String(pid) }
      });
      stopper.once("error", reject);
      stopper.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`stop command for pid ${pid} exited with code ${String(code)}`));
      });
    });
    const deadline = Date.now() + KILL_CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (readProcStartTime(pid) !== recordedStartTime) return true;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return readProcStartTime(pid) !== recordedStartTime;
  }

  /** Send SIGTERM to the session's process group as the owning identity. */
  private async signalProcessGroup(session: AcpSession, pid: number): Promise<void> {
    if (!session.identity) {
      // No per-user identity: the launcher started this child directly under
      // its own account, so it may signal it directly, same as before.
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        session.child.kill("SIGTERM");
      }
      return;
    }
    // The runtime image has no separate `kill` program (only util-linux for
    // setpriv), so the stop signal is sent by the runner's own Node binary
    // instead, run through setpriv as the slot straight at the process
    // group — no shell in between (task 5b, Architect ruling on
    // Astra-Reviewer round-four finding, 2026-09-08). The pid travels by
    // environment variable, not by argv, so there is no ambiguity about how
    // Node indexes process.argv under -e.
    const { command, args } = buildSetprivDropCommand(
      process.execPath,
      ["-e", "process.kill(-Number(process.env.ACP_STOP_PID), 'SIGTERM')"],
      session.identity
    );
    await new Promise<void>((resolve, reject) => {
      const stopper = spawn(command, args, {
        stdio: "ignore",
        env: { ...buildSanitizedCliEnv(process.env), ACP_STOP_PID: String(pid) }
      });
      stopper.once("error", (error) => reject(error));
      stopper.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`stop command for pid ${pid} exited with code ${String(code)}`));
      });
    });
  }

  /** Wait for the session's own exit handler to fire, or time out and report it. */
  private async awaitExit(session: AcpSession, timeoutMs = KILL_CONFIRM_TIMEOUT_MS): Promise<void> {
    if (session.exited) return;
    await new Promise<void>((resolve, reject) => {
      const onExit = (): void => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        session.child.removeListener("exit", onExit);
        reject(new Error("stop signal sent, but the process did not exit in time"));
      }, timeoutMs);
      session.child.once("exit", onExit);
    });
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (now - session.lastActivity > IDLE_REAP_MS && !session.stopping) {
        this.killRecord(key).catch((error: unknown) => {
          console.error(`[acp-host] ${key} idle stop failed: ${(error as Error).message}`);
        });
      }
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
