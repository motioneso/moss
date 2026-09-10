import { describe, expect, it } from "vitest";
import { redactSecrets, type ProviderKind } from "@moss/ai";
import type { AcpPermissionDecider, AcpTunnel } from "@moss/acp";
import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "./chat-session-manager.js";
import { AcpChatEngine, formatResultRecord, formatToolRecord } from "./acp-chat-engine.js";
import type { ActionResultMetadata, TranscriptRecord } from "./types.js";
import type { ChatAttachmentDto, ChatTurnUsageDto } from "@moss/shared";
import type { PersonaFs } from "./persona.js";
import {
  SECRET_SHAPE_CORPUS,
  serializeSubscriberRecord,
  serializeSubscriberRecords
} from "../../../../tests/unit/helpers/boundary-test-gate.js";

const noopPersonaFs: PersonaFs = {
  async mkdir() {},
  async writeFile() {}
};

class FakeClock implements Clock {
  private current = 1_725_000_000_000;
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

class FakePersistence implements ChatPersistencePort {
  readonly recorded: Array<{
    userText: string;
    assistantReply: string;
    executed: { provider: ProviderKind; model: string };
    opts?: {
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
      readonly activityRecords?: readonly TranscriptRecord[];
      readonly elapsedMs?: number;
      readonly usage?: ChatTurnUsageDto;
    };
  }> = [];

  async resolveActiveProvider(_actorUserId: string) {
    return { provider: "anthropic" as ProviderKind, model: "claude-3-7-sonnet" };
  }

  async openNewConversation(): Promise<void> {}

  async getThreadContext(): Promise<{
    threadTitle: string | null;
    localTimezone: string | null;
    incognito: boolean;
  }> {
    return { threadTitle: null, localTimezone: null, incognito: false };
  }

  async touchExistingThread(): Promise<boolean> {
    return true;
  }

  async listPriorTurns() {
    return { recent: [], oldSummary: null };
  }

  async recordTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: {
      readonly invokedToolNames?: ReadonlySet<string>;
      readonly attachments?: readonly ChatAttachmentDto[];
      readonly actionResults?: readonly ActionResultMetadata[];
      readonly activityRecords?: readonly TranscriptRecord[];
      readonly elapsedMs?: number;
      readonly usage?: ChatTurnUsageDto;
    }
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.recorded.push({
      userText,
      assistantReply,
      executed,
      opts
    });
    return { userMessageId: "user-msg-1", assistantMessageId: "asst-msg-1" };
  }
}

class MockTunnel implements AcpTunnel {
  readonly sent: Array<{ method?: string; params?: Record<string, unknown> }> = [];
  private readonly lines: string[] = [];
  private seq = 0;
  private killed = false;
  private waiting: (() => void) | null = null;
  usageToReturn: Record<string, unknown> | null = null;
  onPrompt?: (tunnel: MockTunnel, id: number) => void;

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
      if (this.onPrompt) {
        this.onPrompt(this, message.id!);
      } else {
        this.emitUpdate({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "done" }
        });
        this.emitPromptResult(message.id!);
      }
    }
  }

  emitUpdate(update: Record<string, unknown>): void {
    this.emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "session-1", update }
    });
  }

  emitPromptResult(id: number): void {
    this.emit({
      jsonrpc: "2.0",
      id,
      result: {
        stopReason: "end_turn",
        ...(this.usageToReturn ? { usage: this.usageToReturn } : {})
      }
    });
  }

  sendAgentRequest(method: string, params: Record<string, unknown>, id = ++this.seq): void {
    this.emit({
      jsonrpc: "2.0",
      id,
      method,
      params
    });
  }

  private emit(message: unknown): void {
    this.lines.push(JSON.stringify(message));
    this.seq += 1;
    this.waiting?.();
    this.waiting = null;
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

  async execStart() {
    return { execId: 1 };
  }

  async execPoll() {
    return { output: "", done: true, exitCode: 0, truncated: false, timedOut: false };
  }

  async execKill() {}
}

describe("task 8a Architect regressions", () => {
  it("Regression 1: Persistence stores 1 thought + 1 tool + 1 result + 1 approval in order + elapsed ms and usage (and elapsed alone when usage absent)", async () => {
    const clock = new FakeClock();
    const persistence = new FakePersistence();
    const tunnel = new MockTunnel();
    tunnel.usageToReturn = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150
    };
    let engineRef: AcpChatEngine | undefined;

    const deps: ChatSessionManagerDeps = {
      engineFactory: (provider, sessionKey, options) => {
        engineRef = new AcpChatEngine(provider, sessionKey, {
          tunnel,
          userId: "user-1",
          projectId: "p1",
          permissionDecider: {
            decide: async () => "allow"
          },
          nextSequence: options?.nextSequence
        });
        return engineRef;
      },
      persistence,
      personaFs: noopPersonaFs,
      clock,
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "persona"
    };

    const manager = new ChatSessionManager(deps);
    const serializedSeen: TranscriptRecord[] = [];
    const writeOrder: string[] = [];
    let approvalInjected = false;
    manager.subscribe("user-1", (record) => {
      const snapshot = serializeSubscriberRecord(record);
      serializedSeen.push(snapshot);
      if (snapshot.kind === "tool" && !approvalInjected) {
        approvalInjected = true;
        writeOrder.push("tool-write-held");
        manager.injectRecord("user-1", {
          kind: "action_result",
          actionRequestId: "tc-1",
          toolName: "calendar.list",
          outcome: "executed",
          decidedBy: "person",
          durationMs: 1500,
          text: "Allowed"
        });
        writeOrder.push("approval-written");
      } else if (snapshot.kind === "result" && approvalInjected) {
        // The manager has upserted the buffered tool before the next engine record is emitted.
        writeOrder.push("tool-write-released");
      }
    });

    tunnel.onPrompt = (t, promptId) => {
      // 1. Thought
      t.emitUpdate({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Planning actions" }
      });
      // 2. Tool
      t.emitUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title: "calendar.list",
        name: "calendar.list",
        _meta: { claudeCode: { toolName: "calendar.list" } },
        rawInput: { window: "today" }
      });
      // 3. Result
      t.emitUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-1",
        rawOutput: "Found 2 events"
      });
      // The approval arrives while these engine records are still buffered.
      t.sendAgentRequest("session/request_permission", {
        sessionId: "session-1",
        toolCall: { toolCallId: "tc-1", title: "calendar.list" },
        options: [{ optionId: "opt-1", name: "Allow", kind: "allow_once" }]
      });
      // Reply
      t.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "All finished." }
      });
      t.emitPromptResult(promptId);
    };

    await manager.submitTurn("user-1", "Ben", "Run plan");
    expect(persistence.recorded).toHaveLength(1);
    const recorded = persistence.recorded[0]!;
    expect(recorded.assistantReply).toBe("All finished.");
    expect(typeof recorded.opts?.elapsedMs).toBe("number");
    expect(recorded.opts?.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedReadTokens: undefined,
      thoughtTokens: undefined
    });

    const activity = recorded.opts?.activityRecords ?? [];
    expect(writeOrder).toEqual(["tool-write-held", "approval-written", "tool-write-released"]);
    expect(
      serializedSeen
        .filter((record) => record.kind === "tool" || record.kind === "approved")
        .map((record) => record.kind)
    ).toEqual(["tool", "approved"]);
    expect(activity.map((r) => r.kind)).toEqual([
      "thought",
      "tool",
      "result",
      "action_result",
      "approved"
    ]);
    expect(activity[0]?.text).toBe("Planning actions");
    expect(activity[1]?.text).toBe("calendar.list, today");
    expect(activity[2]?.text).toBe("Found 2 events");
    expect(activity[4]?.text).toMatch(/calendar\.list, approved by you at \d\d:\d\d after 2 s/);

    // Elapsed alone when usage absent
    const tunnel2 = new MockTunnel();
    tunnel2.usageToReturn = null;
    const persistence2 = new FakePersistence();
    const deps2: ChatSessionManagerDeps = {
      ...deps,
      engineFactory: (provider, sessionKey, options) =>
        new AcpChatEngine(provider, sessionKey, {
          tunnel: tunnel2,
          userId: "user-1",
          projectId: "p1",
          nextSequence: options?.nextSequence
        }),
      persistence: persistence2
    };
    const manager2 = new ChatSessionManager(deps2);
    const serializedMirror: TranscriptRecord[] = [];
    manager2.subscribe("user-1", (record) =>
      serializedMirror.push(serializeSubscriberRecord(record))
    );
    tunnel2.onPrompt = (t, promptId) => {
      // Mirror case: the approval is created first, then the engine announces the tool.
      manager2.injectRecord("user-1", {
        kind: "action_result",
        actionRequestId: "mirror-1",
        toolName: "calendar.list",
        outcome: "executed",
        decidedBy: "person",
        durationMs: 1500,
        text: "Allowed"
      });
      t.emitUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "mirror-1",
        title: "calendar.list",
        name: "calendar.list",
        rawInput: { window: "today" }
      });
      t.emitUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Mirror finished." }
      });
      t.emitPromptResult(promptId);
    };
    await manager2.submitTurn("user-1", "Ben", "Hello");
    expect(persistence2.recorded).toHaveLength(1);
    expect(typeof persistence2.recorded[0]?.opts?.elapsedMs).toBe("number");
    expect(persistence2.recorded[0]?.opts?.usage).toBeUndefined();
    const mirrorActivity = persistence2.recorded[0]?.opts?.activityRecords ?? [];
    expect(mirrorActivity.filter((r) => r.kind === "approved" || r.kind === "tool")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "approved" }),
        expect.objectContaining({ kind: "tool" })
      ])
    );
    expect(
      mirrorActivity.filter((r) => r.kind === "approved" || r.kind === "tool").map((r) => r.kind)
    ).toEqual(["approved", "tool"]);
    expect(
      serializedMirror.filter((r) => r.kind === "approved" || r.kind === "tool").map((r) => r.kind)
    ).toEqual(["approved", "tool"]);

    await engineRef?.kill();
  });

  it("Regression 2: Result and tool argument summaries mask every supported secret shape", async () => {
    for (const secretShape of SECRET_SHAPE_CORPUS) {
      expect(redactSecrets(secretShape.sample)).not.toContain(secretShape.value);
    }

    // 1. Tool argument summary redaction
    const queryShape = SECRET_SHAPE_CORPUS.find(({ name }) => name === "query api_key")!;
    const toolRecord = formatToolRecord({
      toolCallId: "call-sec",
      toolName: "fetch",
      rawInput: {
        url: queryShape.sample,
        path: "/plain/path"
      }
    });

    expect(toolRecord.text).not.toContain(queryShape.value);
    expect(toolRecord.text).toContain("/plain/path");
    expect(toolRecord.text.toLowerCase()).toContain("[redacted");

    // 2. Result text redaction
    for (const secretShape of SECRET_SHAPE_CORPUS) {
      const resultRecord = formatResultRecord({
        toolCallId: "call-sec",
        rawOutput: secretShape.sample
      });
      expect(resultRecord?.text).not.toContain(secretShape.value);
    }
  });

  it("Regression 3: Engine permission wrapper delegates without writing approval records", async () => {
    const tunnel = new MockTunnel();
    let currentVerdict: "allow" | "deny" = "allow";

    const decider: AcpPermissionDecider = {
      decide: async () => currentVerdict
    };

    const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
      tunnel,
      userId: "u1",
      projectId: "thread-1"
    });

    const wrapped = (
      engine as unknown as {
        wrapPermissionDecider: (d: AcpPermissionDecider) => AcpPermissionDecider;
      }
    ).wrapPermissionDecider(decider)!;

    // The manager owns approval-line derivation from gateway action_result records.
    currentVerdict = "allow";
    await wrapped.decide({ toolName: "bash", toolCallId: "t1" } as never, {} as never);
    let records = serializeSubscriberRecords((await engine.readNew(0)).records);
    expect(records.filter((r) => r.kind === "approved")).toHaveLength(0);

    // All decisions pass through to ACP without creating duplicate engine records.
    currentVerdict = "allow";
    const offsetBefore = (await engine.readNew(0)).offset;
    await wrapped.decide({ toolName: "read_file", toolCallId: "t2" } as never, {} as never);
    const afterPolicyAllow = serializeSubscriberRecords(
      (await engine.readNew(offsetBefore)).records
    );
    expect(
      afterPolicyAllow.filter(
        (r) => r.kind === "approved" || r.kind === "not_approved" || r.kind === "refused"
      )
    ).toHaveLength(0);

    currentVerdict = "deny";
    await wrapped.decide({ toolName: "delete_db", toolCallId: "t3" } as never, {} as never);
    records = serializeSubscriberRecords((await engine.readNew(0)).records);
    expect(records.filter((r) => r.kind === "refused")).toHaveLength(0);

    currentVerdict = "deny";
    await wrapped.decide({ toolName: "format_disk", toolCallId: "t4" } as never, {} as never);
    records = serializeSubscriberRecords((await engine.readNew(0)).records);
    expect(records.filter((r) => r.kind === "not_approved")).toHaveLength(0);
  });

  it("Regression 4: Moss tool approval maps injected action_result into Approved/Not approved line with hold time", () => {
    const clock = new FakeClock();
    const persistence = new FakePersistence();
    const deps: ChatSessionManagerDeps = {
      engineFactory: () => {
        throw new Error("not used");
      },
      persistence,
      personaFs: noopPersonaFs,
      clock,
      idleMs: 60_000,
      neutralBase: "/tmp",
      persona: "persona"
    };

    const manager = new ChatSessionManager(deps);
    const seen: TranscriptRecord[] = [];
    manager.subscribe("user-1", (r) => seen.push(serializeSubscriberRecord(r)));

    // Request at T=0
    manager.injectRecord("user-1", {
      kind: "action_request",
      actionRequestId: "req-cal-1",
      text: ""
    });

    // Advance clock 2.4s
    clock.advance(2400);

    // Completed result
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-cal-1",
      toolName: "calendar.createEvent",
      outcome: "executed",
      decidedBy: "person",
      durationMs: 2400,
      text: "",
      result: { eventId: "event-1" },
      affectsQueryKeys: ["calendar.events"]
    });

    const originalResult = seen.find(
      (r) => r.kind === "action_result" && r.actionRequestId === "req-cal-1"
    );
    expect(originalResult).toEqual({
      kind: "action_result",
      actionRequestId: "req-cal-1",
      toolName: "calendar.createEvent",
      outcome: "executed",
      decidedBy: "person",
      durationMs: 2400,
      text: "",
      result: { eventId: "event-1" },
      affectsQueryKeys: ["calendar.events"]
    });
    const approvals = seen.filter((r) => r.kind === "approved");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]?.text).toMatch(
      /calendar\.createEvent, approved by you at \d\d:\d\d after 2 s/
    );

    // Denied result
    manager.injectRecord("user-1", {
      kind: "action_request",
      actionRequestId: "req-cal-2",
      text: ""
    });
    clock.advance(4100);
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-cal-2",
      toolName: "calendar.deleteEvent",
      outcome: "denied",
      decidedBy: "person",
      durationMs: 4100,
      text: ""
    });

    const notApproved = seen.filter((r) => r.kind === "not_approved");
    expect(notApproved).toHaveLength(1);
    expect(notApproved[0]?.text).toMatch(
      /calendar\.deleteEvent, not approved by you at \d\d:\d\d after 4 s/
    );

    // Every gateway decision has explicit provenance; policy allow is intentionally silent.
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-person-allow",
      toolName: "tasks.create",
      outcome: "executed",
      decidedBy: "person",
      durationMs: 1200,
      text: "executed"
    });
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-policy-deny",
      toolName: "tasks.delete",
      outcome: "denied",
      decidedBy: "policy",
      reason: "rate limited",
      text: "denied"
    });
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-policy-allow",
      toolName: "tasks.list",
      outcome: "allowed",
      decidedBy: "policy",
      text: "allowed"
    });
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-timeout",
      toolName: "tasks.update",
      outcome: "denied",
      decidedBy: "timeout",
      reason: "Action timed out.",
      durationMs: 3000,
      text: "denied"
    });
    manager.injectRecord("user-1", {
      kind: "action_result",
      actionRequestId: "req-cancel",
      toolName: "tasks.update",
      outcome: "denied",
      decidedBy: "cancelled",
      reason: "Action cancelled.",
      durationMs: 300,
      text: "denied"
    });
    expect(
      seen.filter((r) => r.toolName === "tasks.list" && r.kind !== "action_result")
    ).toHaveLength(0);
    expect(seen.filter((r) => r.toolName === "tasks.delete" && r.kind === "refused")).toHaveLength(
      1
    );
    const nonHuman = seen.filter((r) => r.toolName === "tasks.update" && r.kind === "not_approved");
    expect(nonHuman).toHaveLength(2);
    expect(nonHuman.every((r) => !r.text.includes("by you"))).toBe(true);
  });

  it("Regression 5: Tool update refreshes line with path; display title without real name never shows title", async () => {
    const tunnel = new MockTunnel();
    const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
      tunnel,
      userId: "u1",
      projectId: "thread-1"
    });

    // Announcement with display title but NO real tool name:
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-grep-1",
        title: "Search for files in repo",
        locations: [{ path: "/workspace/src" }]
      }
    });

    const { records } = await engine.readNew(0);
    const serializedRecords = serializeSubscriberRecords(records);
    expect(serializedRecords).toHaveLength(1);
    // Never displays title "Search for files in repo"; falls back to "tool"
    expect(serializedRecords[0]?.text).toBe("tool, /workspace/src");
    expect(serializedRecords[0]?.text).not.toContain("Search for files");

    const firstRecord = serializedRecords[0]!;

    // Later update carries real tool name and path
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-grep-1",
        toolName: "grep",
        locations: [{ path: "/workspace/src/index.ts" }]
      }
    });

    const updates = serializeSubscriberRecords((await engine.readNew(0)).records);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: firstRecord.id,
      sequence: firstRecord.sequence,
      text: "grep, /workspace/src/index.ts"
    });
  });

  it("Regression 6: Live thought: first chunk emits Thought record, second chunk extends it live; storage holds one joined line", async () => {
    const tunnel = new MockTunnel();
    const engine = new AcpChatEngine("anthropic", "chat:u1:thread-1", {
      tunnel,
      userId: "u1",
      projectId: "thread-1"
    });

    // First thought chunk
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Considering the problem." }
      }
    });

    const { records } = await engine.readNew(0);
    const afterFirstChunk = serializeSubscriberRecords(records);
    expect(afterFirstChunk).toHaveLength(1);
    expect(afterFirstChunk[0]?.kind).toBe("thought");
    expect(afterFirstChunk[0]?.text).toBe("Considering the problem.");

    // Second thought chunk
    engine.handleSessionUpdate({
      update: {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: " Looking at calendar entries." }
      }
    });

    const updates = serializeSubscriberRecords((await engine.readNew(0)).records);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: afterFirstChunk[0]?.id,
      sequence: afterFirstChunk[0]?.sequence,
      text: "Considering the problem. Looking at calendar entries."
    });
  });
});
