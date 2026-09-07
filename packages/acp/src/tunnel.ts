/**
 * The runner tunnel the ACP client speaks through (#2369 slice 1).
 *
 * The adapter subprocess runs on the cli-runner host; this interface is the only
 * thing `@moss/acp` needs from the RPC layer, so unit tests can fake it and the
 * production wiring can back it with the chat-engine RPC client.
 */

export interface AcpExecPoll {
  readonly output: string;
  readonly done: boolean;
  readonly exitCode: number | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface AcpTunnel {
  /** Start the adapter for a session key; resolves the runner-side working folder. */
  spawn(sessionKey: string, projectId: string): Promise<{ cwd: string }>;
  /** Deliver one client-to-agent JSON-RPC line (no trailing newline). */
  send(sessionKey: string, line: string): Promise<void>;
  /** Drain adapter stdout lines after a sequence cursor. */
  read(
    sessionKey: string,
    afterSeq: number
  ): Promise<{
    lines: readonly string[];
    firstSeq: number;
    nextSeq: number;
    exited: boolean;
    truncated: boolean;
  }>;
  /** Stop the adapter for a session key. Idempotent. */
  kill(sessionKey: string): Promise<void>;
  /**
   * Run one shell command in the session project folder (phase 3). The tunnel
   * resolves the folder runner-side from the session key plus projectId; the
   * caller never passes a path.
   */
  execStart(
    sessionKey: string,
    projectId: string,
    command: string,
    timeoutMs?: number
  ): Promise<{
    execId: number;
  }>;
  /** Read output so far for one build. */
  execPoll(sessionKey: string, execId: number): Promise<AcpExecPoll>;
  /** Stop one build. Idempotent. */
  execKill(sessionKey: string, execId: number): Promise<void>;
}
