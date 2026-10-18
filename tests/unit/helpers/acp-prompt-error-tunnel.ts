import type { AcpTunnel } from "@moss/acp";

/** Scripted ACP agent that answers the prompt (or session/new) with a chosen JSON-RPC error. */
export class PromptErrorTunnel implements AcpTunnel {
  textBeforeError: string | null = null;
  readonly sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  private readonly lines: string[] = [];
  private seq = 0;
  private killed = false;
  private waiting: (() => void) | null = null;

  constructor(
    private readonly failOnSessionNew = false,
    private readonly promptError: { code: number; message: string; data?: unknown } = {
      code: -32000,
      message: "Authentication required"
    },
    private readonly sessionNewError: { code: number; message: string; data?: unknown } = {
      code: -32000,
      message: "Authentication required"
    }
  ) {}

  async spawn() {
    return { cwd: "/tmp/acp", home: "/tmp/home", pid: 1, uid: 1, gid: 1 };
  }

  async send(_sessionKey: string, line: string): Promise<void> {
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    if (message.method === "initialize") {
      this.emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: { image: true, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true }
          }
        }
      });
    } else if (message.method === "session/new") {
      this.emit(
        this.failOnSessionNew
          ? {
              jsonrpc: "2.0",
              id: message.id,
              error: this.sessionNewError
            }
          : { jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } }
      );
    } else if (message.method === "session/prompt") {
      if (this.textBeforeError)
        this.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: this.textBeforeError }
            }
          }
        });
      this.emit({
        jsonrpc: "2.0",
        id: message.id,
        error: this.promptError
      });
    }
  }

  async read(
    _sessionKey: string,
    afterSeq: number
  ): Promise<{
    lines: readonly string[];
    firstSeq: number;
    nextSeq: number;
    exited: boolean;
    truncated: boolean;
  }> {
    const lines = this.lines.slice(afterSeq);
    if (lines.length === 0 && !this.killed) {
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
      return this.read(_sessionKey, afterSeq);
    }
    return {
      lines,
      firstSeq: afterSeq + 1,
      nextSeq: this.seq,
      exited: this.killed,
      truncated: false
    };
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.waiting?.();
    this.waiting = null;
  }

  async execStart(): Promise<{ execId: number }> {
    return { execId: 1 };
  }

  async execPoll(): Promise<{
    output: string;
    done: boolean;
    exitCode: number | null;
    truncated: boolean;
    timedOut: boolean;
  }> {
    return { output: "", done: true, exitCode: 0, truncated: false, timedOut: false };
  }

  async execKill(): Promise<void> {}

  private emit(message: unknown): void {
    this.lines.push(JSON.stringify(message));
    this.seq += 1;
    this.waiting?.();
    this.waiting = null;
  }
}
