// #1059 — owns AT MOST ONE live owner terminal. Opening a new one evicts the prior
// (single active session, per the security model). Idle timeout hard-kills the PTY.
import { randomUUID } from "node:crypto";
import { TerminalSession, type TerminalSessionOptions } from "./terminal-session.js";
import type {
  RpcOpenTerminalParams,
  RpcOpenTerminalResult,
  RpcWriteTerminalParams,
  RpcResizeTerminalParams,
  RpcKillTerminalParams
} from "@moss/chat/live";

export interface TerminalSink {
  // #1526 — a `false` return means the connection's socket write hit backpressure;
  // TerminalHost pauses the PTY until the caller reports a drain via `resume()`.
  data(terminalId: string, bytes: Buffer): boolean | void;
  exit(terminalId: string, code: number): void;
}
export interface TerminalHostDeps {
  readonly homeBase: string;
  readonly toolsBinDir: string;
  readonly idleMs?: number;
  readonly makeSession?: (o: TerminalSessionOptions) => TerminalSession;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000; // 10 min, spec

export class TerminalHost {
  private session: TerminalSession | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: TerminalHostDeps) {}

  open(params: RpcOpenTerminalParams, sink: TerminalSink): RpcOpenTerminalResult {
    this.killAll(); // evict any prior — single active session
    const id = randomUUID();
    const make = this.deps.makeSession ?? ((o) => new TerminalSession(o));
    const session = make({
      id,
      cols: params.cols,
      rows: params.rows,
      homeBase: this.deps.homeBase,
      toolsBinDir: this.deps.toolsBinDir
    });
    session.onData((bytes) => {
      // #1059: this closure outlives eviction — a killed session's PTY read-buffer
      // can still deliver trailing bytes async. Only the LIVE session's output may
      // rearm the idle timer, or a dead session's straggler data would keep its
      // successor's timeout alive forever. Bytes still forward unconditionally —
      // they belong to this terminalId regardless of liveness.
      if (this.session?.id === id) this.touch();
      const outcome = sink.data(id, bytes);
      // #1526 — only the LIVE session may be paused by a stale/evicted callback's outcome,
      // same liveness guard as touch() above.
      if (outcome === false && this.session?.id === id) this.session.pause();
    });
    session.onExit((code) => {
      sink.exit(id, code);
      this.clear(id);
    });
    this.session = session;
    this.armIdle();
    return { terminalId: id };
  }

  write(params: RpcWriteTerminalParams): void {
    // #1059: forId() already no-ops the write for a stale/unknown terminalId, but
    // touch() must not run unconditionally — otherwise an RPC referencing a dead
    // terminalId would still extend the CURRENT live session's idle timer, defeating
    // the idle-timeout security control.
    const session = this.forId(params.terminalId);
    if (!session) return;
    session.write(Buffer.from(params.dataB64, "base64"));
    this.touch();
  }
  resize(params: RpcResizeTerminalParams): void {
    this.forId(params.terminalId)?.resize(params.cols, params.rows);
  }
  // #1526 — a drain for an evicted/killed terminal is a no-op: forId() only returns the
  // session whose id is still the current live one.
  resume(terminalId: string): void {
    this.forId(terminalId)?.resume();
  }
  kill(params: RpcKillTerminalParams): void {
    this.clear(params.terminalId);
  }
  killAll(): void {
    if (this.session) this.clear(this.session.id);
  }

  private forId(id: string): TerminalSession | null {
    return this.session && this.session.id === id ? this.session : null;
  }
  private clear(id: string): void {
    if (this.session && this.session.id === id) {
      this.session.kill();
      this.session = null;
      if (this.idleTimer) {
        clearTimeout(this.idleTimer);
        this.idleTimer = null;
      }
    }
  }
  private armIdle(): void {
    const ms = this.deps.idleMs ?? DEFAULT_IDLE_MS;
    this.idleTimer = setTimeout(() => this.killAll(), ms);
  }
  private touch(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.armIdle();
    }
  }
}
