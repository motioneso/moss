import { describe, expect, it, vi } from "vitest";

import type { AcpTunnel } from "@moss/acp";

import { AcpChatEngine } from "./acp-chat-engine.js";

class PromptErrorTunnel implements AcpTunnel {
  readonly sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  private readonly lines: string[] = [];
  private seq = 0;
  private killed = false;
  private waiting: (() => void) | null = null;

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
      this.emit({ jsonrpc: "2.0", id: message.id, result: { sessionId: "session-1" } });
    } else if (message.method === "session/prompt") {
      this.emit({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Authentication required" }
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

describe("AcpChatEngine", () => {
  it("turns an authentication failure into the chat sign-in message", async () => {
    const tunnel = new PromptErrorTunnel();
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
      tunnel,
      userId: "u1",
      projectId: "thread-1",
      reportLoginRejected: loginRejected
    });

    await engine.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));

    await expect(engine.readNew(0)).rejects.toEqual(
      expect.objectContaining({
        name: "CliChatUnavailableError",
        message:
          "The Claude sign-in has expired; an admin can log it in again under Settings, Assistant & AI"
      })
    );
    expect(loginRejected).toHaveBeenCalledOnce();
    expect(tunnel.sent.map(({ method }) => method)).toEqual([
      "initialize",
      "session/new",
      "session/prompt"
    ]);
    await engine.kill();
  });

  it("declares that its own kill path purges private data, needing no API-side purge call", async () => {
    const tunnel = new PromptErrorTunnel();
    const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
      tunnel,
      userId: "u1",
      projectId: "thread-1"
    });

    expect(engine.handlesOwnPrivatePurge).toBe(true);
    await engine.kill();
  });
});
