/**
 * The runner tunnel the ACP client speaks through (slice 1, chat first).
 *
 * The adapter subprocess runs on the cli-runner host; this interface is the only
 * thing `@moss/acp` needs from the RPC layer, so unit tests can fake it and the
 * production wiring can back it with the chat-engine RPC client.
 */

import type { AcpProfile } from "./capabilities.js";
import type { AcpProviderKind } from "./providers.js";

export interface AcpExecPoll {
  readonly output: string;
  readonly done: boolean;
  readonly exitCode: number | null;
  readonly truncated: boolean;
  readonly timedOut: boolean;
}

export interface AcpTunnel {
  /**
   * Start one provider's agent for a session key; resolves the runner-side working
   * folder plus the HOME handed to the agent process (null when none). The kind,
   * the user and the profile are required: the runner refuses a spawn without
   * them, with no default.
   */
  spawn(
    sessionKey: string,
    projectId: string,
    providerKind: AcpProviderKind,
    userId: string,
    profile: AcpProfile
  ): Promise<{ cwd: string; home: string | null }>;
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
