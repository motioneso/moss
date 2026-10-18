import { describe, expect, it, vi } from "vitest";

import type { AcpProviderKind, AcpTunnel } from "@moss/acp";

import {
  AcpChatEngine,
  formatApprovalRecord,
  formatRefusalRecord,
  formatReplyRecord,
  formatResultRecord,
  formatThoughtRecord,
  formatToolRecord,
  MAX_RESULT_CHARS,
  RpcAcpTunnel,
  toAcpProviderKind
} from "./acp-chat-engine.js";
import { API_KEY_REJECTED_MESSAGE } from "./auth-errors.js";
import type { RpcConnection } from "./chat-engine-rpc-client.js";
import { CliChatUnavailableError } from "./errors.js";
import { serializeSubscriberRecords } from "../../../../tests/unit/helpers/boundary-test-gate.js";

class PromptErrorTunnel implements AcpTunnel {
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

class PromptMockTunnel implements AcpTunnel {
  readonly sent: Array<{ id?: number; method?: string; params?: Record<string, unknown> }> = [];
  readonly spawnedProviders: AcpProviderKind[] = [];
  modelValues: string[] | null = null;
  private readonly lines: string[] = [];
  private seq = 0;
  private killed = false;
  private waiting: (() => void) | null = null;
  usageToReturn: Record<string, unknown> | null = null;
  textToStream = "Hello there!";
  holdPrompt = false;

  async spawn(_sessionKey: string, _projectId: string, providerKind: AcpProviderKind) {
    this.spawnedProviders.push(providerKind);
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
      this.emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          sessionId: "session-1",
          ...(this.modelValues === null
            ? {}
            : {
                configOptions: [
                  {
                    type: "select",
                    id: "model",
                    name: "Model",
                    category: "model",
                    currentValue: this.modelValues[0] ?? "default",
                    options: this.modelValues.map((value) => ({ name: value, value }))
                  }
                ]
              })
        }
      });
    } else if (message.method === "session/set_config_option") {
      this.emit({ jsonrpc: "2.0", id: message.id, result: { configOptions: [] } });
    } else if (message.method === "session/prompt") {
      this.emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: this.textToStream }
          }
        }
      });
      if (this.holdPrompt) return;
      this.emit({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          stopReason: "end_turn",
          ...(this.usageToReturn ? { usage: this.usageToReturn } : {})
        }
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

  emit(message: unknown): void {
    this.lines.push(JSON.stringify(message));
    this.seq += 1;
    this.waiting?.();
    this.waiting = null;
  }
}

describe("ACP reply streaming", () => {
  it("replaces the streamed identity with the completed answer and usage", async () => {
    const tunnel = new PromptMockTunnel();
    tunnel.holdPrompt = true;
    const spawn = vi.spyOn(tunnel, "spawn");
    const engine = new AcpChatEngine("anthropic", "stream-final", {
      tunnel,
      userId: "u1",
      projectId: "thread-1"
    });
    await engine.launch({
      neutralDir: "/tmp/acp",
      personaPath: "/tmp/acp/persona.md",
      personaText: "Trusted Moss persona"
    });
    expect(spawn).toHaveBeenCalledWith(
      "stream-final",
      "thread-1",
      "anthropic",
      "u1",
      "chat",
      "Trusted Moss persona"
    );
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const partial = await engine.readNew(0);
    expect(partial.complete).toBe(false);
    expect(partial.records).toHaveLength(1);
    const prompt = tunnel.sent.find((message) => message.method === "session/prompt")!;
    tunnel.emit({
      jsonrpc: "2.0",
      id: prompt.id,
      result: {
        stopReason: "end_turn",
        usage: { inputTokens: 5, outputTokens: 3 }
      }
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const final = await engine.readNew(0);
    expect(final.records).toHaveLength(1);
    expect(final.records[0]).toMatchObject({
      kind: "reply",
      text: "Hello there!",
      id: partial.records[0]!.id,
      sequence: partial.records[0]!.sequence,
      usage: { inputTokens: 5, outputTokens: 3 }
    });
    expect((await engine.readNew(0)).complete).toBe(true);
    await engine.kill();
  });

  it("discards partial replies on failure and ignores late chunks", async () => {
    const tunnel = new PromptErrorTunnel();
    tunnel.textBeforeError = "unfinished";
    const engine = new AcpChatEngine("anthropic", "stream-failure", {
      tunnel,
      userId: "u1",
      projectId: "thread-1",
      reportLoginRejected: vi.fn()
    });
    await engine.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(engine.readNew(0)).rejects.toThrow();
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "late" }
      }
    });
    expect((await engine.readNew(0)).records.filter((record) => record.kind === "reply")).toEqual(
      []
    );
    await engine.kill();
  });

  it("publishes cumulative reply snapshots before completion with one stable identity", async () => {
    const engine = new AcpChatEngine("anthropic", "stream-test", {
      tunnel: new PromptMockTunnel(),
      userId: "u1",
      projectId: "thread-1"
    });
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Hello" }
      }
    });
    const first = await engine.readNew(0);
    expect(first.complete).toBe(false);
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({ kind: "reply", text: "Hello" });
    expect(first.records[0]?.id).toBeTruthy();
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: " there!" }
      }
    });
    const next = await engine.readNew(0);
    expect(next.records[0]).toMatchObject({
      kind: "reply",
      text: "Hello there!",
      id: first.records[0]!.id,
      sequence: first.records[0]!.sequence
    });
    expect(next.complete).toBe(false);
  });
});

describe("AcpChatEngine", () => {
  it("routes OpenAI-compatible chats to Codex", () => {
    expect(toAcpProviderKind("openai-compatible")).toBe("openai");
    expect(toAcpProviderKind("openai-compatible", "codex-acp")).toBe("openai");
    expect(toAcpProviderKind("openai-compatible", "opencode")).toBe("opencode");
  });

  it("routes OpenCode only from the selected persisted agent identity", async () => {
    const tunnel = new PromptMockTunnel();
    tunnel.modelValues = ["default", "muse-spark-1.3-free"];
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:selected-opencode", {
      tunnel,
      acpAgentId: "opencode",
      userId: "u1",
      projectId: "selected-opencode",
      log: vi.fn()
    });

    await engine.launch({
      neutralDir: "/tmp/acp",
      personaPath: "/tmp/acp/persona.md",
      model: "default",
      acpModel: "muse-spark-1.3-free"
    });

    expect(tunnel.spawnedProviders).toEqual(["opencode"]);
    expect(
      tunnel.sent.find((message) => message.method === "session/set_config_option")?.params
    ).toMatchObject({ configId: "model", value: "muse-spark-1.3-free" });
    await engine.kill();
  });

  it("keeps OpenAI-selected chat on Codex when a stale OpenCode model is present", async () => {
    const tunnel = new PromptMockTunnel();
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:stale-opencode-model", {
      tunnel,
      userId: "u1",
      projectId: "stale-opencode-model",
      log: vi.fn()
    });

    await engine.launch({
      neutralDir: "/tmp/acp",
      personaPath: "/tmp/acp/persona.md",
      model: "gpt-sol",
      acpModel: "muse-spark-1.3-free"
    });

    expect(tunnel.spawnedProviders).toEqual(["openai"]);
    await engine.kill();
  });

  it("applies the selected OpenAI model when Codex advertises the stale OpenCode model too", async () => {
    const tunnel = new PromptMockTunnel();
    tunnel.modelValues = ["gpt-sol", "muse-spark-1.3-free"];
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:selected-openai-model", {
      tunnel,
      userId: "u1",
      projectId: "selected-openai-model",
      log: vi.fn()
    });

    await engine.launch({
      neutralDir: "/tmp/acp",
      personaPath: "/tmp/acp/persona.md",
      model: "gpt-sol",
      acpModel: "muse-spark-1.3-free"
    });

    expect(tunnel.spawnedProviders).toEqual(["openai"]);
    expect(
      tunnel.sent.find((message) => message.method === "session/set_config_option")?.params
    ).toMatchObject({ configId: "model", value: "gpt-sol" });
    await engine.kill();
  });

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
          "The Claude sign-in has expired; an admin can log it in again under Settings, AI providers"
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

  it("uses the truthful Codex remediation for launch and prompt auth failures", async () => {
    const expected =
      "Codex is not connected yet. An administrator connects it once for everyone under Settings, AI providers.";

    const launchFailure = new AcpChatEngine("openai-compatible", "chat:u1:launch", {
      tunnel: new PromptErrorTunnel(true),
      userId: "u1",
      projectId: "launch"
    });
    await expect(
      launchFailure.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" })
    ).rejects.toMatchObject({ name: "CliChatUnavailableError", message: expected });

    const promptFailure = new AcpChatEngine("openai-compatible", "chat:u1:prompt", {
      tunnel: new PromptErrorTunnel(),
      userId: "u1",
      projectId: "prompt"
    });
    await promptFailure.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
    await promptFailure.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(promptFailure.readNew(0)).rejects.toMatchObject({
      name: "CliChatUnavailableError",
      message: expected
    });
    await promptFailure.kill();
  });

  it("classifies ACP prompt rejection without retaining provider data", async () => {
    const engine = new AcpChatEngine("anthropic", "chat:u1:prompt-rejected", {
      tunnel: new PromptErrorTunnel(false, {
        code: -32003,
        message: "Provider rejected PRIVATE_PROMPT_CANARY",
        data: { token: "PRIVATE_TOKEN_CANARY" }
      }),
      userId: "u1",
      projectId: "prompt-rejected"
    });

    await engine.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
    await engine.submit("private prompt");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "AcpPromptFailureError",
      message: "ACP prompt rejected",
      failureStage: "acp_prompt_rejected",
      acpCode: -32003
    });
    expect(JSON.stringify(failure)).not.toContain("PRIVATE_TOKEN_CANARY");
    expect(failure).not.toHaveProperty("cause");
    expect(failure).not.toHaveProperty("data");
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

  describe("record mapping (task 8a)", () => {
    it("maps an agent_thought_chunk update to a thought line", () => {
      const record = formatThoughtRecord("Sam is in contacts. Thursday is the 10th.");
      expect(record).toEqual({
        kind: "thought",
        text: "Sam is in contacts. Thursday is the 10th."
      });
    });

    it("joins consecutive thought chunks per thought in the engine", async () => {
      const tunnel = new PromptErrorTunnel();
      const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
        tunnel,
        userId: "u1",
        projectId: "thread-1"
      });

      engine.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Sam is in contacts. " }
        }
      });
      engine.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thursday is the 10th." }
        }
      });
      // A subsequent tool call flushes the accumulated thought
      engine.handleSessionUpdate({
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          toolName: "calendar.listEvents",
          rawInput: { window: "Thursday 11:00 to 14:00" }
        }
      });

      const records = serializeSubscriberRecords((await engine.readNew(0)).records);
      expect(records).toHaveLength(3);
      expect(records[0]).toMatchObject({
        kind: "thought",
        text: "Sam is in contacts. "
      });
      expect(records[1]).toMatchObject({
        kind: "thought",
        id: records[0]?.id,
        sequence: records[0]?.sequence,
        text: "Sam is in contacts. Thursday is the 10th."
      });
      expect(records[2]).toMatchObject({
        kind: "tool",
        toolName: "calendar.listEvents",
        toolCallId: "call-1",
        text: "calendar.listEvents, Thursday 11:00 to 14:00"
      });
    });

    it("maps a tool_call update to a tool line with real name and summarised arguments", () => {
      // Window argument
      const call1 = formatToolRecord({
        toolCallId: "call-1",
        toolName: "calendar.listEvents",
        rawInput: { window: "Thursday 11:00 to 14:00" }
      });
      expect(call1).toEqual({
        kind: "tool",
        toolName: "calendar.listEvents",
        toolCallId: "call-1",
        text: "calendar.listEvents, Thursday 11:00 to 14:00"
      });

      // Path arguments from rawInput and locations
      const call2 = formatToolRecord({
        toolCallId: "call-2",
        toolName: "Read",
        rawInput: { file_path: "packages/shared/src/chat-api.ts" }
      });
      expect(call2).toEqual({
        kind: "tool",
        toolName: "Read",
        toolCallId: "call-2",
        text: "Read, packages/shared/src/chat-api.ts"
      });

      // Web address / URL argument
      const call3 = formatToolRecord({
        toolCallId: "call-3",
        toolName: "WebFetch",
        rawInput: { url: "https://example.com/api" }
      });
      expect(call3).toEqual({
        kind: "tool",
        toolName: "WebFetch",
        toolCallId: "call-3",
        text: "WebFetch, https://example.com/api"
      });

      // Real tool name extracted from _meta.claudeCode
      const call4 = formatToolRecord({
        toolCallId: "call-4",
        title: "Model Tool Title",
        _meta: { claudeCode: { toolName: "calendar.createEvent" } },
        rawInput: { query: "lunch" }
      });
      expect(call4).toEqual({
        kind: "tool",
        toolName: "calendar.createEvent",
        toolCallId: "call-4",
        text: "calendar.createEvent, lunch"
      });

      // Shell commands are never stored in summarised arguments
      const call5 = formatToolRecord({
        toolCallId: "call-5",
        toolName: "Bash",
        rawInput: { command: "cat /etc/passwd" }
      });
      expect(call5).toEqual({
        kind: "tool",
        toolName: "Bash",
        toolCallId: "call-5",
        text: "Bash"
      });

      const call6 = formatToolRecord({
        toolCallId: "call-6",
        name: "mcp.moss.calendar.listEvents",
        rawInput: { server: "moss", tool: "calendar.listEvents", arguments: {} }
      });
      expect(call6).toEqual({
        kind: "tool",
        toolName: "mcp__moss__calendar_listEvents",
        toolCallId: "call-6",
        text: "mcp__moss__calendar_listEvents"
      });
    });

    it("maps a tool_call_update to a result line capped at MAX_RESULT_CHARS", () => {
      const update1 = formatResultRecord({
        toolCallId: "call-1",
        rawOutput: "No events in that window."
      });
      expect(update1).toEqual({
        kind: "result",
        toolCallId: "call-1",
        text: "No events in that window."
      });

      // Result capping
      const longOutput = "x".repeat(600);
      const update2 = formatResultRecord({
        toolCallId: "call-2",
        rawOutput: longOutput
      });
      expect(update2?.text).toHaveLength(MAX_RESULT_CHARS + 1); // 500 chars + "…"
      expect(update2?.text.endsWith("…")).toBe(true);
    });

    it("shows quotes and ampersands in a gateway-wrapped result as plain characters (#2816)", () => {
      const wrapped =
        '<tool_result source="briefings.run">\n{&quot;title&quot;: &quot;Tom &amp;amp; Jerry&quot;, &#39;x&#39;}\n</tool_result>';
      const record = formatResultRecord({ toolCallId: "call-q", rawOutput: wrapped });
      expect(record?.text).toBe(`{"title": "Tom &amp; Jerry", 'x'}`);
    });

    it("keeps angle-bracket markup in a wrapped result as literal text (#2816)", () => {
      const wrapped =
        '<tool_result source="web.fetch">\n&lt;script&gt;alert(1)&lt;/script&gt; &amp;lt;b&amp;gt;\n</tool_result>';
      const text = formatResultRecord({ rawOutput: wrapped })?.text ?? "";
      expect(text).toBe("<script>alert(1)</script> &lt;b&gt;");
    });

    it("reads the wrapped text out of a nested tool response, as the live chat sends it (#2816)", () => {
      const text =
        '<tool_result source="briefings.getRunStatus">\n{\n  &quot;state&quot;: &quot;not_found&quot;\n}\n</tool_result>';
      const record = formatResultRecord({
        toolCallId: "call-n",
        rawOutput: {
          result: { content: [{ type: "text", text }], structuredContent: null },
          error: null
        }
      });
      expect(record?.text).toBe('{\n  "state": "not_found"\n}');
    });

    it("peels the envelope before the display cap, so long results are still plain (#2816)", () => {
      const body = "&quot;".repeat(300);
      const wrapped = `<tool_result source="t.tool">\n${body}\n</tool_result>`;
      const text = formatResultRecord({ rawOutput: wrapped })?.text ?? "";
      expect(text).toBe('"'.repeat(300));
    });

    it("leaves the model-facing wrapped text byte-identical (#2816)", async () => {
      const { renderAndCap } = await import("@moss/ai");
      const out = renderAndCap(undefined, { data: { q: 'a "b" & <c>' } } as never, "t.tool");
      expect(out.text).toBe(
        '<tool_result source="t.tool">\n{\n  &quot;q&quot;: &quot;a \\&quot;b\\&quot; &amp; &lt;c&gt;&quot;\n}\n</tool_result>'
      );
    });

    it("maps approval and refusal lines", () => {
      // Approved
      const approved = formatApprovalRecord({
        toolName: "calendar.createEvent",
        approved: true,
        who: "you",
        at: "14:46",
        durationSec: 9
      });
      expect(approved).toEqual({
        kind: "approved",
        toolName: "calendar.createEvent",
        text: "calendar.createEvent, approved by you at 14:46 after 9 s",
        durationMs: 9000
      });

      // Not approved
      const notApproved = formatApprovalRecord({
        toolName: "calendar.createEvent",
        approved: false,
        who: "you",
        at: "14:46",
        durationSec: 9
      });
      expect(notApproved).toEqual({
        kind: "not_approved",
        toolName: "calendar.createEvent",
        text: "calendar.createEvent, not approved by you at 14:46 after 9 s",
        durationMs: 9000
      });

      // Refused with reason
      const refused = formatRefusalRecord({
        toolName: "calendar.createEvent",
        reason: "forbidden zone"
      });
      expect(refused).toEqual({
        kind: "refused",
        toolName: "calendar.createEvent",
        text: "calendar.createEvent, refused (forbidden zone)"
      });
    });

    it("stores elapsed time alone when usage is absent", () => {
      const record = formatReplyRecord("Done.", 1234, null);
      expect(record).toEqual({
        kind: "reply",
        text: "Done.",
        elapsedMs: 1234
      });
      expect(record.usage).toBeUndefined();
    });

    it("stores elapsed time and usage block including thought tokens when usage is present", () => {
      const usage = {
        inputTokens: 100,
        outputTokens: 45,
        totalTokens: 175,
        cachedReadTokens: 10,
        cachedWriteTokens: 5,
        thoughtTokens: 20
      };
      const record = formatReplyRecord("Done.", 2500, usage);
      expect(record).toEqual({
        kind: "reply",
        text: "Done.",
        elapsedMs: 2500,
        usage: {
          inputTokens: 100,
          outputTokens: 45,
          totalTokens: 175,
          cachedReadTokens: 10,
          cachedWriteTokens: 5,
          thoughtTokens: 20
        }
      });
    });

    it("persists elapsed time and usage on reply when engine prompt completes", async () => {
      const tunnel = new PromptMockTunnel();
      tunnel.usageToReturn = {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        cachedReadTokens: 15,
        thoughtTokens: 25
      };
      const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
        tunnel,
        userId: "u1",
        projectId: "thread-1"
      });

      await engine.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
      await engine.submit("Count to three");
      // Allow prompt to finish
      await new Promise((resolve) => setTimeout(resolve, 50));

      const records = serializeSubscriberRecords((await engine.readNew(0)).records);
      const { complete } = await engine.readNew(0);
      expect(complete).toBe(true);
      const replyRecord = records.find((r) => r.kind === "reply");
      expect(replyRecord).toBeDefined();
      expect(replyRecord?.text).toBe("Hello there!");
      expect(typeof replyRecord?.elapsedMs).toBe("number");
      expect(replyRecord?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(replyRecord?.usage).toEqual({
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        cachedReadTokens: 15,
        thoughtTokens: 25
      });
      await engine.kill();
    });

    it("persists elapsed time alone when provider reports no usage", async () => {
      const tunnel = new PromptMockTunnel();
      tunnel.usageToReturn = null;
      const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
        tunnel,
        userId: "u1",
        projectId: "thread-1"
      });

      await engine.launch({ neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" });
      await engine.submit("Hello");
      await new Promise((resolve) => setTimeout(resolve, 50));

      const records = serializeSubscriberRecords((await engine.readNew(0)).records);
      const { complete } = await engine.readNew(0);
      expect(complete).toBe(true);
      const replyRecord = records.find((r) => r.kind === "reply");
      expect(replyRecord).toBeDefined();
      expect(replyRecord?.text).toBe("Hello there!");
      expect(typeof replyRecord?.elapsedMs).toBe("number");
      expect(replyRecord?.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(replyRecord?.usage).toBeUndefined();
      await engine.kill();
    });
  });
});

describe("API-key chat", () => {
  const launchOpts = { neutralDir: "/tmp/acp", personaPath: "/tmp/acp/persona.md" };

  it("routes API-key rows by provider kind alone", () => {
    expect(toAcpProviderKind("anthropic", undefined, "api_key")).toBe("anthropic");
    expect(toAcpProviderKind("openai-compatible", undefined, "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", "codex-acp", "api_key")).toBe("opencode");
    expect(toAcpProviderKind("openai-compatible", undefined, "cli")).toBe("openai");
    expect(() => toAcpProviderKind("google", undefined, "api_key")).toThrow(
      CliChatUnavailableError
    );
  });

  it("names the key, not a CLI sign-in, when the provider refuses a prompt", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-prompt", {
      tunnel: new PromptErrorTunnel(),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-prompt",
      reportLoginRejected: loginRejected
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
    await engine.kill();
  });

  it("names the key when an OpenCode API-key launch is refused", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-launch", {
      tunnel: new PromptErrorTunnel(true),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-launch",
      reportLoginRejected: loginRejected
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      name: "CliChatUnavailableError",
      message: API_KEY_REJECTED_MESSAGE
    });
    expect(failure).not.toHaveProperty("cause");
    expect(loginRejected).not.toHaveBeenCalled();
  });

  it("treats a provider 401 during an API-key prompt as a rejected key", async () => {
    const engine = new AcpChatEngine("openai-compatible", "chat:u1:api-key-401", {
      tunnel: new PromptErrorTunnel(false, {
        code: -32603,
        message: "Upstream 401: invalid api key"
      }),
      authMethod: "api_key",
      userId: "u1",
      projectId: "api-key-401"
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    await expect(engine.readNew(0)).rejects.toMatchObject({ message: API_KEY_REJECTED_MESSAGE });
    await engine.kill();
  });

  // Phase 0 (2026-10-17): with a wrong key, both agents answer the first prompt with a JSON-RPC
  // internal error (-32603) that wraps the provider's 401, never "Authentication required".
  it.each([
    [
      "claude agent",
      "anthropic" as const,
      {
        code: -32603,
        message: "Internal error: Failed to authenticate. API Error: 401",
        data: { errorKind: "authentication_failed" }
      }
    ],
    [
      "OpenCode",
      "openai-compatible" as const,
      {
        code: -32603,
        message: "Internal error: Unauthorized: Invalid API key",
        data: { name: "APIError" }
      }
    ]
  ])(
    "classifies the %s internal error wrapping a 401 as a rejected key",
    async (_label, provider, wrongKeyError) => {
      const loginRejected = vi.fn();
      const engine = new AcpChatEngine(provider, "chat:u1:api-key-internal", {
        tunnel: new PromptErrorTunnel(false, wrongKeyError),
        authMethod: "api_key",
        userId: "u1",
        projectId: "api-key-internal",
        reportLoginRejected: loginRejected
      });
      await engine.launch(launchOpts);
      await engine.submit("hello");
      await new Promise((resolve) => setTimeout(resolve, 25));
      const failure = await engine.readNew(0).catch((error: unknown) => error);
      expect(failure).toMatchObject({
        name: "CliChatUnavailableError",
        message: API_KEY_REJECTED_MESSAGE
      });
      expect(failure).not.toHaveProperty("cause");
      expect(JSON.stringify(failure)).not.toContain("Internal error");
      expect(String((failure as Error).message)).not.toContain("Internal error");
      expect(loginRejected).not.toHaveBeenCalled();
      await engine.kill();
    }
  );

  it("leaves the same internal 401 alone on a CLI-login row", async () => {
    const loginRejected = vi.fn();
    const engine = new AcpChatEngine("anthropic", "chat:u1:cli-internal", {
      tunnel: new PromptErrorTunnel(false, {
        code: -32603,
        message: "Internal error: Failed to authenticate. API Error: 401"
      }),
      userId: "u1",
      projectId: "cli-internal",
      reportLoginRejected: loginRejected
    });
    await engine.launch(launchOpts);
    await engine.submit("hello");
    await new Promise((resolve) => setTimeout(resolve, 25));
    const failure = await engine.readNew(0).catch((error: unknown) => error);
    expect((failure as Error).message).not.toBe(API_KEY_REJECTED_MESSAGE);
    expect(loginRejected).not.toHaveBeenCalled();
    await engine.kill();
  });

  it("sends the credential with the spawn request, and only when one is given", async () => {
    const acpSpawn = vi.fn(async () => ({
      cwd: "/tmp/acp",
      home: "/tmp/home",
      pid: 1,
      uid: 1,
      gid: 1
    }));
    const connection = { acpSpawn } as unknown as RpcConnection;
    const credential = { baseUrl: null, apiKey: "test-key-never-echo-0002", model: "org/model" };
    await new RpcAcpTunnel(connection, "chat:u1:a", { credential }).spawn(
      "chat:u1:a",
      "a",
      "anthropic",
      "u1",
      "chat"
    );
    await new RpcAcpTunnel(connection, "chat:u1:b").spawn(
      "chat:u1:b",
      "b",
      "anthropic",
      "u1",
      "chat"
    );
    const calls = acpSpawn.mock.calls as unknown as [string, Record<string, unknown>][];
    expect(calls[0]?.[1]).toEqual({
      projectId: "a",
      providerKind: "anthropic",
      userId: "u1",
      profile: "chat",
      credential
    });
    expect(calls[1]?.[1]).not.toHaveProperty("credential");
  });

  // No "sk-" prefix, so the generic secret patterns cannot hide a missing exact mask.
  const LAUNCH_KEY = "localproxy0005neverlog";

  it.each([
    ["at the start", `${LAUNCH_KEY} rejected by upstream`],
    ["in the middle", `upstream said ${LAUNCH_KEY} is over quota`],
    ["at the end", `quota exceeded for ${LAUNCH_KEY}`],
    ["repeated", `${LAUNCH_KEY}/${LAUNCH_KEY} twice`]
  ])("masks the key %s of a non-auth API-key launch error", async (_label, message) => {
    const engine = new AcpChatEngine("anthropic", "chat:u1:api-key-mask", {
      tunnel: new PromptErrorTunnel(true, undefined, {
        code: -32603,
        message,
        data: { echo: LAUNCH_KEY }
      }),
      authMethod: "api_key",
      apiKey: LAUNCH_KEY,
      userId: "u1",
      projectId: "api-key-mask"
    });
    const failure = await engine.launch(launchOpts).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("[redacted]");
    expect((failure as Error).message).not.toContain(LAUNCH_KEY);
    expect(failure).not.toHaveProperty("cause");
    expect(JSON.stringify(failure)).not.toContain(LAUNCH_KEY);
  });
});
