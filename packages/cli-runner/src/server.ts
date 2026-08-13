/**
 * CliRunnerServer — binds the private Unix-domain socket (§3.1), runs the startup
 * CLEAN-SLATE sweep BEFORE accepting connections (§4.1.0a/§6.5), and serves each
 * accepted connection through `serveConnection`.
 *
 * Bind hygiene (§3.1): unlink a stale socket path before listen; REFUSE to bind if the
 * path resolves outside the socket dir (`/run/jarv1s` by default). The socket file is
 * created `0600`; the containing dir is `0700` (the root-init chowns/creates it, but we
 * defensively chmod here too).
 */

import { createServer, type Server, type Socket } from "node:net";
import { mkdir, chmod, realpath, unlink, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { serveConnection, type ByteChannel } from "./connection.js";
import type { CliChatEngineHost } from "./engine-host.js";
import type { TerminalHost } from "./terminal-host.js";

export interface CliRunnerServerDeps {
  readonly host: CliChatEngineHost;
  /** #1059 — the single owner-terminal PTY manager, shared across every accepted connection. */
  readonly terminalHost: TerminalHost;
  /** Absolute socket path (`JARVIS_CLI_RUNNER_SOCKET`, §3.1). */
  readonly socketPath: string;
  /** The directory the socket MUST resolve under (`/run/jarv1s` default, §3.1). */
  readonly socketDir: string;
  /** Shared RPC secret (`JARVIS_CLI_RUNNER_RPC_SECRET`, §3.6). Unset ⇒ all hellos close. */
  readonly secret: string | undefined;
  readonly log?: (msg: string) => void;
  /**
   * v0.1.3 max-age login reaper period (ms). While the server runs, it periodically drives
   * `host.reapStaleLogins()` so a login that hung/was abandoned past its lifetime auto-releases
   * the §L.6.1 single-active gate (a disk-level backstop to the per-flow in-memory deadline). The
   * reaper only acts on sessions older than the login lifetime, so a frequent tick never reaps a
   * legitimate in-progress login. Undefined ⇒ {@link DEFAULT_LOGIN_REAPER_INTERVAL_MS}; ≤0 ⇒ off.
   */
  readonly loginReaperIntervalMs?: number;
}

const DEFAULT_LOGIN_REAPER_INTERVAL_MS = 30_000;

export class CliRunnerServer {
  /** Fresh per-process bootId, stamped on every response so the api detects a restart (§5.6). */
  readonly bootId: string = randomUUID();
  private server: Server | null = null;
  /** v0.1.3: the periodic max-age login-reaper timer (cleared on stop). */
  private loginReaperTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * v0.1.3: in-flight guard for the reaper tick. `TmuxIo.run` has no timeout, so a wedged tmux
   * command can make one reap outlast the interval; without this guard a second reap would start on
   * the next tick and pending promises/child processes would accumulate unbounded. The tick skips
   * while a reap is still running and re-runs on the next interval once it settles.
   */
  private loginReapInFlight = false;

  constructor(private readonly deps: CliRunnerServerDeps) {}

  /** Run the startup sweep, then bind + listen. Resolves once listening. */
  async start(): Promise<void> {
    // (1) CLEAN-SLATE sweep BEFORE accepting connections (§4.1.0a (2) / §6.5).
    await this.deps.host.startupSweep();

    // (2) socket dir hygiene: ensure dir exists `0700`.
    await mkdir(this.deps.socketDir, { recursive: true, mode: 0o700 });
    await chmod(this.deps.socketDir, 0o700).catch(() => undefined);

    // (3) refuse to bind outside the socket dir (§3.1) — realpath the DIR (the socket
    // file doesn't exist yet, so realpath the parent and compare).
    await this.assertSocketUnderDir();

    // (4) unlink a stale socket from an unclean shutdown (§3.1).
    await unlink(this.deps.socketPath).catch(() => undefined);

    const server = createServer((socket: Socket) => this.onConnection(socket));
    this.server = server;

    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(this.deps.socketPath, () => {
        server.off("error", reject);
        resolveListen();
      });
    });

    // (5) lock the socket file down to `0600` (same-UID readers are kept out by the
    // §3.6 hello, but other UIDs are kept out by the perms + private volume, §3.1).
    await chmod(this.deps.socketPath, 0o600).catch(() => undefined);
    this.deps.log?.(`[cli-runner] listening on ${this.deps.socketPath} (boot ${this.bootId})`);

    // (6) v0.1.3: start the periodic max-age login reaper (a disk-level backstop that releases the
    // §L.6.1 gate from a hung/abandoned login). unref'd so it never keeps the process alive. A
    // double-start guard clears any prior timer first so a second start() can't orphan it.
    if (this.loginReaperTimer) {
      clearInterval(this.loginReaperTimer);
      this.loginReaperTimer = null;
    }
    const interval = this.deps.loginReaperIntervalMs ?? DEFAULT_LOGIN_REAPER_INTERVAL_MS;
    if (interval > 0) {
      this.loginReaperTimer = setInterval(() => {
        // In-flight guard: skip this tick if the previous reap is still running (a wedged tmux
        // command must NOT let reaps stack up — see loginReapInFlight). Re-runs next interval.
        if (this.loginReapInFlight) return;
        this.loginReapInFlight = true;
        void this.deps.host
          .reapStaleLogins()
          .catch(() => undefined)
          .finally(() => {
            this.loginReapInFlight = false;
          });
      }, interval);
      if (typeof this.loginReaperTimer.unref === "function") this.loginReaperTimer.unref();
    }

    // (7) #1554 task #5: arm the persistent-pool idle-reap timer (Decision 3). Mirrors step (6)'s
    // shape; `host.startIdleReapTimer()` itself no-ops when no pool was wired at composition time
    // (`main.ts`'s `createCliRunner`), so this call is unconditional and harmless either way.
    this.deps.host.startIdleReapTimer();
  }

  private onConnection(socket: Socket): void {
    socket.on("error", () => {
      // swallow — serveConnection registers its own close handler.
    });
    const channel: ByteChannel = socket as unknown as ByteChannel;
    serveConnection(channel, {
      host: this.deps.host,
      bootId: this.bootId,
      secret: this.deps.secret,
      terminalHost: this.deps.terminalHost
    });
  }

  /**
   * Defend the client/server against a redirected socket path (§3.1): the resolved
   * parent of the socket path MUST be the configured socket dir (realpath both, then
   * prefix-check). Throws if the socket would land outside the dir.
   */
  private async assertSocketUnderDir(): Promise<void> {
    const parent = dirname(resolve(this.deps.socketPath));
    let realParent: string;
    let realDir: string;
    try {
      realParent = await realpath(parent);
    } catch {
      realParent = parent;
    }
    try {
      realDir = await realpath(this.deps.socketDir);
    } catch {
      realDir = resolve(this.deps.socketDir);
    }
    const normalizedDir = realDir.endsWith(sep) ? realDir.slice(0, -1) : realDir;
    if (realParent !== normalizedDir) {
      throw new Error(
        `refusing to bind: socket path ${this.deps.socketPath} resolves outside ${this.deps.socketDir}`
      );
    }
    // Sanity: the dir must be a directory.
    const dirStat = await stat(realDir).catch(() => null);
    if (dirStat && !dirStat.isDirectory()) {
      throw new Error(`refusing to bind: ${this.deps.socketDir} is not a directory`);
    }
  }

  async stop(): Promise<void> {
    // Clear the periodic login reaper first (it may be armed even if the server never bound). Reset
    // the in-flight flag so a later start() begins clean (an in-flight reap's `finally` is harmless
    // — it just re-clears the already-false flag).
    if (this.loginReaperTimer) {
      clearInterval(this.loginReaperTimer);
      this.loginReaperTimer = null;
    }
    this.loginReapInFlight = false;
    // #1554 task #5: mirror the login reaper's teardown for the idle-reap timer.
    this.deps.host.stopIdleReapTimer();
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((res) => server.close(() => res()));
    await unlink(this.deps.socketPath).catch(() => undefined);
  }
}
