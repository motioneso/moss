import { describe, expect, it, vi } from "vitest";

import type { AcpTunnel } from "@moss/acp";

import {
  AcpChatEngine,
  formatApprovalRecord,
  formatRefusalRecord,
  formatReplyRecord,
  formatResultRecord,
  formatThoughtRecord,
  formatToolRecord,
  MAX_RESULT_CHARS,
  toAcpProviderKind
} from "./acp-chat-engine.js";
import { serializeSubscriberRecords } from "../../../../tests/unit/helpers/boundary-test-gate.js";

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

class PromptMockTunnel implements AcpTunnel {
  readonly sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  private readonly lines: string[] = [];
  private seq = 0;
  private killed = false;
  private waiting: (() => void) | null = null;
  usageToReturn: Record<string, unknown> | null = null;
  textToStream = "Hello there!";

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
        method: "session/update",
        params: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: this.textToStream }
          }
        }
      });
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

  private emit(message: unknown): void {
    this.lines.push(JSON.stringify(message));
    this.seq += 1;
    this.waiting?.();
    this.waiting = null;
  }
}

describe("AcpChatEngine", () => {
  it("routes the openai-compatible chat row to OpenCode", () => {
    expect(toAcpProviderKind("openai-compatible")).toBe("opencode");
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
