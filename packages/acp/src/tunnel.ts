/**
 * The runner tunnel the ACP client speaks through (#2369 slice 1).
 *
 * The adapter subprocess runs on the cli-runner host; this interface is the only
 * thing `@moss/acp` needs from the RPC layer, so unit tests can fake it and the
 * production wiring can back it with the chat-engine RPC client.
 */

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
}
