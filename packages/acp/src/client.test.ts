import { describe, expect, it, vi } from "vitest";

import { MossAcpClient } from "./client.js";
import type { AcpTunnel } from "./tunnel.js";

/**
 * A scripted stand-in for the adapter: answers initialize/new/prompt over the
 * tunnel and records every line the client sends. This proves request/response
 * matching, text collection, and the deny-by-default permission posture without
 * starting a process.
 */
class ScriptedAgent implements AcpTunnel {
  readonly sent: string[] = [];
  private readonly outbox: string[] = [];
  private seq = 0;
  hangPrompt = false;

  async spawn(): Promise<{ cwd: string; generation: number }> {
    return { cwd: "/runner/session/acp/proj", generation: 1 };
  }

  async send(_sessionKey: string, line: string): Promise<void> {
    this.sent.push(line);
    const msg = JSON.parse(line) as { id?: number; method?: string };
    if (msg.method === "initialize") {
      this.emit({ jsonrpc: "2.0", id: msg.id, result: fullCapabilities() });
    } else if (msg.method === "session/new") {
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agent-sess-1" } });
    } else if (msg.method === "session/prompt") {
      if (this.hangPrompt) return;
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "hello from the agent" }
          }
        }
      });
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-sess-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "call-1",
            title: "Read",
            status: "pending",
            kind: "read"
          }
        }
      });
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
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
    const lines = this.outbox.slice(afterSeq);
    return { lines, firstSeq: afterSeq + 1, nextSeq: this.seq, exited: false, truncated: false };
  }

  async kill(): Promise<void> {}

  /** Agent-initiated request, e.g. a built-in asking for approval. */
  agentAsksPermission(id: number): void {
    this.emit({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "agent-sess-1",
        toolCall: { toolCallId: "call-9", title: "Write", kind: "edit" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
      }
    });
  }

  private emit(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.seq += 1;
  }
}

function fullCapabilities() {
  return {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, embeddedContext: true },
      mcpCapabilities: { http: true, sse: true }
    }
  };
}

describe("MossAcpClient", () => {
  it("opens a session, collects streamed text, and reports the stop reason", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession("workshop:user:proj", "proj");
    expect(handle.sessionId).toBe("agent-sess-1");
    expect(handle.cwd).toBe("/runner/session/acp/proj");

    const result = await client.prompt(handle, "say hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("hello from the agent");
    expect(result.toolCallsSeen).toBe(1);

    // The client pinned protocol v1 and advertised no file or terminal access.
    const init = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "initialize");
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities ?? {}).toEqual({});
    // The agent's own tools are switched off: files and commands are Moss tools.
    const opened = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/new");
    expect(opened.params._meta).toEqual({ disableBuiltInTools: true });
    // No tool server handed over unless the caller provides one.
    expect(opened.params.mcpServers).toEqual([]);
    await client.close(handle);
  });

  it("hands Moss's tool server over inside the session opening", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession("workshop:user:proj", "proj", "workshop", {
      url: "http://moss.local/api/mcp",
      bearer: "jst_test-token"
    });
    expect(handle.sessionId).toBe("agent-sess-1");

    const opened = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/new");
    // The Bearer [REDACTED] inside this entry, in the open, for the adapter to hand to the
    // agent launch: anyone who removes the header breaks tool access, and anyone
    // reading it must treat it as exposed on the agent command line.
    expect(opened.params.mcpServers).toEqual([
      {
        type: "http",
        name: "moss",
        url: "http://moss.local/api/mcp",
        headers: [{ name: "Authorization", value: "Bearer jst_test-token" }]
      }
    ]);
    await client.close(handle);
  });

  it("revokes the tool server Bearer [REDACTED] the session closes", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    let revoked = 0;
    const handle = await client.openSession("workshop:user:proj", "proj", "workshop", {
      url: "http://moss.local/api/mcp",
      bearer: "jst_test-token",
      onClose: () => {
        revoked += 1;
      }
    });
    await client.close(handle);
    expect(revoked).toBe(1);
    // Closing again revokes nothing further.
    await client.close(handle);
    expect(revoked).toBe(1);
  });

  it("gives up on a hung agent instead of hanging the caller", async () => {
    // An agent that answers the handshake but never the prompt.
    const agent = new ScriptedAgent();
    agent.hangPrompt = true;
    const client = new MossAcpClient(agent);
    const handle = await client.openSession("workshop:user:proj", "proj");
    await expect(client.prompt(handle, "hello?", { timeoutMs: 50 })).rejects.toThrow(
      /timed out after 50 ms/
    );
    // The deadline cancels the turn on the way out.
    const cancels = agent.sent
      .map((line) => JSON.parse(line))
      .filter((msg) => msg.method === "session/cancel");
    expect(cancels).toHaveLength(1);
    await client.close(handle);
  });

  it("denies permission requests it has no policy for", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession("workshop:user:proj", "proj");
    agent.agentAsksPermission(7);
    await vi.waitFor(() => {
      const answers = agent.sent
        .map((line) => JSON.parse(line))
        .filter((msg) => msg.id === 7 && msg.result !== undefined);
      expect(answers.length).toBe(1);
    });
    const answer = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.id === 7 && msg.result !== undefined);
    expect(answer.result.outcome).toEqual({ outcome: "cancelled" });
    await client.close(handle);
  });
});
