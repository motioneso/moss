import { describe, expect, it, vi } from "vitest";

import { AcpSessionOpenError, MossAcpClient } from "./client.js";
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
  private promptCount = 0;
  receivedSystemPrompt: string | null = null;
  private killed = false;
  private pendingRead: (() => void) | null = null;
  readCount = 0;
  killCalls: string[] = [];
  pollingStopped = false;
  hangPrompt = false;
  failInitialize = false;
  killFailure: Error | null = null;

  async spawn(): Promise<{
    cwd: string;
    home: string | null;
    pid: number | null;
    uid: number;
    gid: number;
  }> {
    return {
      cwd: "/runner/session/acp/proj",
      home: "/home/agent",
      pid: 12345,
      uid: 2001,
      gid: 2001
    };
  }

  async send(_sessionKey: string, line: string): Promise<void> {
    this.sent.push(line);
    const msg = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { _meta?: { systemPrompt?: unknown } };
    };
    if (msg.method === "initialize") {
      this.emit(
        this.failInitialize
          ? { jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "init failed" } }
          : { jsonrpc: "2.0", id: msg.id, result: fullCapabilities() }
      );
    } else if (msg.method === "session/new") {
      const prompt = msg.params?._meta?.systemPrompt;
      this.receivedSystemPrompt = typeof prompt === "string" ? prompt : null;
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agent-sess-1" } });
    } else if (msg.method === "session/prompt") {
      if (this.hangPrompt) return;
      const promptNumber = ++this.promptCount;
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "agent-sess-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: promptNumber === 1 ? "hello from the agent" : `reply-${promptNumber}`
            }
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
            toolCallId: `call-${promptNumber}-1`,
            title: "Read",
            status: "pending",
            kind: "read"
          }
        }
      });
      if (promptNumber > 1) {
        this.emit({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: "agent-sess-1",
            update: {
              sessionUpdate: "tool_call",
              toolCallId: `call-${promptNumber}-2`,
              title: "Read again",
              status: "pending",
              kind: "read"
            }
          }
        });
      }
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
    this.readCount += 1;
    if (this.killed) {
      this.pollingStopped = true;
      return {
        lines: [],
        firstSeq: afterSeq + 1,
        nextSeq: this.seq,
        exited: true,
        truncated: false
      };
    }
    const lines = this.outbox.slice(afterSeq);
    if (lines.length === 0) {
      return new Promise((resolve) => {
        this.pendingRead = () => {
          this.pendingRead = null;
          if (this.killed) this.pollingStopped = true;
          resolve(
            this.killed
              ? {
                  lines: [],
                  firstSeq: afterSeq + 1,
                  nextSeq: this.seq,
                  exited: true,
                  truncated: false
                }
              : {
                  lines: this.outbox.slice(afterSeq),
                  firstSeq: afterSeq + 1,
                  nextSeq: this.seq,
                  exited: false,
                  truncated: false
                }
          );
        };
      });
    }
    return { lines, firstSeq: afterSeq + 1, nextSeq: this.seq, exited: false, truncated: false };
  }

  async kill(sessionKey: string): Promise<void> {
    this.killCalls.push(sessionKey);
    if (this.killFailure) {
      const error = this.killFailure;
      this.killFailure = null;
      throw error;
    }
    this.killed = true;
    const wake = this.pendingRead;
    setTimeout(() => wake?.(), 20);
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

  /**
   * The adapter's tool-use announcement, in its exact shape: the tool call id
   * plus the real name under metadata, alongside title, kind and locations.
   */
  agentAnnouncesToolCall(toolCall: Record<string, unknown>): void {
    this.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "agent-sess-1",
        update: { sessionUpdate: "tool_call", status: "pending", ...toolCall }
      }
    });
  }

  /**
   * The adapter's permission question, in its exact shape: only the tool call
   * id, the raw input and the display title — never a name, kind or locations.
   */
  agentAsksPermission(id: number, toolCall: Record<string, unknown>): void {
    this.emit({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "agent-sess-1",
        toolCall: { toolCallId: "call-9", ...toolCall },
        options: [
          { optionId: "allow_always", name: "Always Allow", kind: "allow_always" },
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" }
        ]
      }
    });
  }

  private emit(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.seq += 1;
    this.pendingRead?.();
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
  it("cleans up the spawned agent and tool server when initialization fails", async () => {
    const agent = new ScriptedAgent();
    agent.failInitialize = true;
    let revoked = 0;
    const client = new MossAcpClient(agent);

    await expect(
      client.openSession("chat:user:proj", "proj", "anthropic", "user-1", "chat", {
        url: "http://moss.local/api/mcp",
        bearer: "test-token",
        onClose: () => {
          revoked += 1;
        }
      })
    ).rejects.toThrow();

    expect(agent.killCalls).toEqual(["chat:user:proj"]);
    expect(agent.pollingStopped).toBe(true);
    expect(revoked).toBe(1);
  });

  it("reports refused startup cleanup and leaves a retry path", async () => {
    const agent = new ScriptedAgent();
    agent.failInitialize = true;
    agent.killFailure = new Error("STOP REFUSED");
    let revoked = 0;
    const client = new MossAcpClient(agent);

    let failure: unknown;
    try {
      await client.openSession("chat:user:proj", "proj", "anthropic", "user-1", "chat", {
        url: "http://moss.local/api/mcp",
        bearer: "test-token",
        onClose: () => {
          revoked += 1;
        }
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AcpSessionOpenError);
    if (!(failure instanceof AcpSessionOpenError)) throw failure;
    expect(failure.message).toMatch(/cleanup failed \(STOP REFUSED\)/);
    expect(agent.killCalls).toEqual(["chat:user:proj"]);
    expect(revoked).toBe(0);
    expect(typeof failure.cleanup.close).toBe("function");

    await failure.cleanup.close();
    expect(agent.killCalls).toEqual(["chat:user:proj", "chat:user:proj"]);
    expect(agent.pollingStopped).toBe(true);
    expect(revoked).toBe(1);

    await failure.retryCleanup();
    expect(agent.killCalls).toHaveLength(2);
  });

  it("opens a session, collects streamed text, and reports the stop reason", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat",
      undefined,
      "You are Jarvis."
    );
    expect(handle.sessionId).toBe("agent-sess-1");
    expect(handle.cwd).toBe("/runner/session/acp/proj");

    const result = await client.prompt(handle, "say hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.text).toBe("hello from the agent");
    expect(result.toolCallsSeen).toBe(1);

    // The client pinned protocol v1 and sent the row's off-list.
    const init = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "initialize");
    expect(init.params.protocolVersion).toBe(1);
    expect(init.params.clientCapabilities ?? {}).toEqual({});
    // The row's off-list travels in the row's mechanism: the agent's
    // disallowed-tools list, taken from the tool table's chat column.
    const opened = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.method === "session/new");
    const { launchOffList } = await import("./tool-table.js");
    expect(opened.params._meta).toEqual({
      claudeCode: { options: { disallowedTools: launchOffList("chat") } },
      systemPrompt: "You are Jarvis."
    });
    expect(agent.receivedSystemPrompt).toBe("You are Jarvis.");
    // No tool server handed over unless the caller provides one.
    expect(opened.params.mcpServers).toEqual([]);
    await client.close(handle);
  });

  it("isolates reply text and tool counts between prompt turns", async () => {
    const agent = new ScriptedAgent();
    const beginTurn = vi.fn();
    const client = new MossAcpClient(agent, {}, { decide: async () => "deny", beginTurn });
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );

    await expect(client.prompt(handle, "first")).resolves.toMatchObject({
      text: "hello from the agent",
      toolCallsSeen: 1
    });
    await expect(client.prompt(handle, "second")).resolves.toMatchObject({
      text: "reply-2",
      toolCallsSeen: 2
    });
    expect(beginTurn).toHaveBeenNthCalledWith(1, "agent-sess-1", expect.any(String));
    expect(beginTurn).toHaveBeenNthCalledWith(2, "agent-sess-1", expect.any(String));
    expect(beginTurn.mock.calls[0]?.[1]).not.toBe(beginTurn.mock.calls[1]?.[1]);
    await client.close(handle);
  });

  it("kills the runner session and ends polling before revoking on close", async () => {
    const agent = new ScriptedAgent();
    const order: string[] = [];
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat",
      {
        url: "http://moss.local/api/mcp",
        bearer: "jst_test-token",
        onClose: () => order.push(agent.pollingStopped ? "revoke" : "polling-active")
      }
    );

    await client.close(handle);
    expect(agent.killCalls).toEqual(["workshop:user:proj"]);
    expect(order).toEqual(["revoke"]);
    expect(agent.pollingStopped).toBe(true);
    const readsAfterStop = agent.readCount;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(agent.readCount).toBe(readsAfterStop);
  });

  it("hands Moss's tool server over inside the session opening", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat",
      {
        url: "http://moss.local/api/mcp",
        bearer: "jst_test-token"
      }
    );
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
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat",
      {
        url: "http://moss.local/api/mcp",
        bearer: "jst_test-token",
        onClose: () => {
          revoked += 1;
        }
      }
    );
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
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
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

  it("decides by the announced name when the announcement lands first", async () => {
    const agent = new ScriptedAgent();
    const seen: Array<string | null> = [];
    const folders: unknown[] = [];
    const client = new MossAcpClient(
      agent,
      {},
      {
        decide: async (builtIn, session) => {
          seen.push(builtIn.toolName);
          folders.push({ cwd: session.cwd, home: session.home });
          return "allow";
        }
      }
    );
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
    agent.agentAnnouncesToolCall({
      toolCallId: "call-9",
      title: "Read src/a.ts",
      kind: "read",
      rawInput: { file_path: "src/a.ts" },
      _meta: { claudeCode: { toolName: "Read" } }
    });
    agent.agentAsksPermission(8, { title: "Read src/a.ts", rawInput: { file_path: "src/a.ts" } });
    const answer = await waitForAnswer(agent, 8);
    // The question's title is ignored; the announced name decides, and the
    // spawn's folders travel with the decision.
    expect(seen).toEqual(["Read"]);
    expect(folders).toEqual([{ cwd: "/runner/session/acp/proj", home: "/home/agent" }]);
    expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    await client.close(handle);
  });

  it("settles a gateway-backed permission ask before cancelling the ACP session", async () => {
    const agent = new ScriptedAgent();
    let resolveDecision: ((decision: "allow" | "deny") => void) | undefined;
    const decider = {
      decide: vi.fn(
        () =>
          new Promise<"allow" | "deny">((resolve) => {
            resolveDecision = resolve;
          })
      ),
      cancelSession: vi.fn(() => {
        resolveDecision?.("deny");
      })
    };
    const client = new MossAcpClient(agent, {}, decider);
    const handle = await client.openSession(
      "chat:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );

    agent.agentAnnouncesToolCall({
      toolCallId: "call-9",
      title: "`pnpm build`",
      kind: "execute",
      rawInput: { command: "pnpm build" },
      _meta: { claudeCode: { toolName: "Bash" } }
    });
    agent.agentAsksPermission(8, { title: "`pnpm build`", rawInput: { command: "pnpm build" } });
    await vi.waitFor(() => expect(decider.decide).toHaveBeenCalledOnce());

    await client.cancel(handle);

    expect(decider.cancelSession).toHaveBeenCalledWith("agent-sess-1");
    const answer = await waitForAnswer(agent, 8);
    expect(answer.result.outcome).toEqual({ outcome: "cancelled" });
    await client.close(handle);
  });

  it("decides by the announced name when the question lands first", async () => {
    const agent = new ScriptedAgent();
    const seen: Array<string | null> = [];
    const client = new MossAcpClient(
      agent,
      {},
      {
        decide: async (builtIn) => {
          seen.push(builtIn.toolName);
          return "allow";
        }
      }
    );
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
    agent.agentAsksPermission(8, { title: "`pnpm build`", rawInput: { command: "pnpm build" } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    agent.agentAnnouncesToolCall({
      toolCallId: "call-9",
      title: "`pnpm build`",
      kind: "execute",
      rawInput: { command: "pnpm build" },
      _meta: { claudeCode: { toolName: "Bash" } }
    });
    const answer = await waitForAnswer(agent, 8);
    expect(seen).toEqual(["Bash"]);
    expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    await client.close(handle);
  });

  it("refuses when no announcement arrives within the bound", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent, {}, { decide: async () => "allow" as const });
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
    agent.agentAsksPermission(8, { title: "Read everything", rawInput: { prompt: "go" } });
    // The two second announcement wait runs before the refusal.
    const answer = await waitForAnswer(agent, 8, 10_000);
    expect(answer.result.outcome).toEqual({ outcome: "cancelled" });
    await client.close(handle);
  });

  it("refuses when the announcement carries no name", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent, {}, { decide: async () => "allow" as const });
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
    agent.agentAnnouncesToolCall({ toolCallId: "call-9", title: "mystery" });
    agent.agentAsksPermission(8, { title: "mystery", rawInput: {} });
    const answer = await waitForAnswer(agent, 8);
    expect(answer.result.outcome).toEqual({ outcome: "cancelled" });
    await client.close(handle);
  });

  it("denies permission answers when no decider is wired", async () => {
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(agent);
    const handle = await client.openSession(
      "workshop:user:proj",
      "proj",
      "anthropic",
      "user-1",
      "chat"
    );
    agent.agentAnnouncesToolCall({
      toolCallId: "call-9",
      title: "Read src/a.ts",
      _meta: { claudeCode: { toolName: "Read" } }
    });
    agent.agentAsksPermission(7, { title: "Read src/a.ts", rawInput: {} });
    const answer = await waitForAnswer(agent, 7);
    expect(answer.result.outcome).toEqual({ outcome: "cancelled" });
    await client.close(handle);
  });
});

async function waitForAnswer(
  agent: ScriptedAgent,
  id: number,
  timeout = 5000
): Promise<{ result: { outcome: unknown } }> {
  await vi.waitFor(
    () => {
      const answers = agent.sent
        .map((line) => JSON.parse(line))
        .filter((msg) => msg.id === id && msg.result !== undefined);
      expect(answers.length).toBe(1);
    },
    { timeout }
  );
  return agent.sent
    .map((line) => JSON.parse(line))
    .find((msg) => msg.id === id && msg.result !== undefined);
}
