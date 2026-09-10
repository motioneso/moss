import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_REFUSED_REASON,
  AssistantToolGateway,
  ConfirmationRegistry,
  InvalidSessionTokenError,
  SessionTokenRegistry
} from "@moss/ai";

const CWD = "/runner/session/acp/proj";

interface FakeStore {
  created: unknown[];
  createStarted: boolean;
  createGate?: Promise<void>;
  emitted: unknown[];
  audit: unknown[];
  actionRow: { id: string; status: string };
}

function buildGateway(store: FakeStore, confirmTimeoutMs = 1000) {
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    repository: {
      // Rows are numbered in creation order so two asks can be told apart.
      createPendingAssistantAction: async (_db: unknown, input: unknown) => {
        store.createStarted = true;
        await store.createGate;
        store.created.push(input);
        return { ...store.actionRow, id: `acp-action-${store.created.length}` };
      },
      getAssistantAction: async (_db: unknown, id: string) => ({ ...store.actionRow, id }),
      resolveAssistantAction: async (_db: unknown, id: string) => ({ ...store.actionRow, id }),
      insertActionAuditLog: async (_db: unknown, input: unknown) => {
        store.audit.push(input);
      }
    } as never,
    runner: {
      withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) => work({})
    } as never,
    tokens,
    confirmations,
    notifier: {
      emit: (_chatSessionId: string, record: unknown) => store.emitted.push(record)
    },
    confirmTimeoutMs
  });
  return { gateway, tokens, confirmations };
}

function freshStore(): FakeStore {
  return {
    created: [],
    createStarted: false,
    emitted: [],
    audit: [],
    actionRow: { id: "acp-action-1", status: "pending" }
  };
}

describe("agent built-in permission through the shared approval card", () => {
  it("raises the same card row and event as native asks, owned by the token actor", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-9",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));
    expect(store.created[0]).toMatchObject({
      toolModuleId: "acp-builtin",
      toolModuleName: "Agent Built-in Tools",
      toolName: "Bash",
      permissionId: "acp-builtin.Bash",
      risk: "destructive"
    });
    expect(store.emitted[0]).toMatchObject({
      kind: "action_request",
      actionRequestId: "acp-action-1",
      toolName: "Bash"
    });

    // The person answers through the same function the Approve button calls.
    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "confirmed")).resolves.toBe(
      "resolved"
    );

    await expect(pending).resolves.toMatchObject({
      decision: "allow",
      reason: "Approved by user.",
      asked: true
    });
    expect((await pending).holdDurationMs).toBeGreaterThan(0);
    await vi.waitFor(() => expect(store.emitted).toHaveLength(2));
    expect(store.emitted[1]).toMatchObject({
      kind: "action_result",
      actionRequestId: "acp-action-1",
      toolName: "Bash",
      outcome: "allowed"
    });
  });

  it("saves the agent session and folder on the row for later readers", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-9",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.created).toHaveLength(1));
    expect(store.created[0]).toMatchObject({
      inputSummary: {
        agent: {
          sessionId: "agent-sess-1",
          toolCallId: "call-9",
          toolName: "Bash",
          cwd: CWD,
          paths: [],
          decision: "asked",
          reason: null
        }
      }
    });
    const summary = (store.created[0] as { inputSummary: Record<string, unknown> }).inputSummary;
    expect(summary).not.toHaveProperty("command");
    expect(JSON.stringify(summary)).not.toContain("pnpm build");
    // The card itself shows the command (live stream only) behind the real name.
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));
    expect(store.emitted[0]).toMatchObject({
      kind: "action_request",
      summary: "The agent wants to use Bash: pnpm build"
    });
    gatewayResolveSoon(gateway, "u1");
    await expect(pending).resolves.toMatchObject({ decision: "allow" });
    // The audit line carries the same identifiers, still without the command.
    await vi.waitFor(() => expect(store.audit).toHaveLength(1));
    expect(store.audit[0]).toMatchObject({
      inputSummary: { agent: { sessionId: "agent-sess-1", toolCallId: "call-9", cwd: CWD } }
    });
    expect(JSON.stringify(store.audit[0])).not.toContain("pnpm build");
  });

  it("asks about a read outside the folder as outbound, with the path on the card and the row", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-9",
      title: "Read File",
      toolInput: { file_path: "/etc/hosts" },
      toolName: "Read",
      kind: "read",
      locations: [{ path: "/etc/hosts" }]
    });
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));
    expect(store.created[0]).toMatchObject({
      toolName: "Read",
      risk: "outbound",
      inputSummary: { agent: { toolName: "Read", paths: ["/etc/hosts"], decision: "asked" } }
    });
    expect(store.emitted[0]).toMatchObject({
      kind: "action_request",
      summary: "The agent wants to use Read: /etc/hosts"
    });
    gatewayResolveSoon(gateway, "u1", "rejected");
    await expect(pending).resolves.toMatchObject({ decision: "deny" });
  });

  it("keeps two agents in one conversation apart: two rows, each naming its own session", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    const ask = (sessionId: string, cwd: string) =>
      gateway.requestAcpBuiltInPermission(token, {
        cwd,
        home: "/home/agent",
        sessionId,
        turnId: `${sessionId}-turn`,
        toolCallId: `${sessionId}-call`,
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" },
        toolName: "Bash"
      });
    const first = ask("agent-sess-1", CWD);
    await vi.waitFor(() => expect(store.created).toHaveLength(1));
    const second = ask("agent-sess-2", "/runner/session/acp/other");
    await vi.waitFor(() => expect(store.created).toHaveLength(2));
    expect(
      store.created.map((row) => (row as { inputSummary: { agent: unknown } }).inputSummary.agent)
    ).toMatchObject([
      { sessionId: "agent-sess-1", toolCallId: "agent-sess-1-call", cwd: CWD },
      {
        sessionId: "agent-sess-2",
        toolCallId: "agent-sess-2-call",
        cwd: "/runner/session/acp/other"
      }
    ]);
    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "confirmed")).resolves.toBe(
      "resolved"
    );
    await expect(gateway.resolveActionRequest("u1", "acp-action-2", "rejected")).resolves.toBe(
      "resolved"
    );
    await expect(first).resolves.toMatchObject({ decision: "allow" });
    await expect(second).resolves.toMatchObject({ decision: "deny" });
  });

  it("refuses a subagent titled like a read, with no card and no row", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-7",
        title: "Read the repository and summarize the layout",
        toolInput: {
          description: "Read the repository and summarize the layout",
          prompt: "Read every file and report back."
        },
        toolName: "Task"
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: false,
      holdDurationMs: null
    });
    expect(store.created).toHaveLength(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("refuses a read-mimicking title with no real name and no row", async () => {
    const store = freshStore();
    const { gateway, tokens, confirmations } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    const awaitResolution = vi.spyOn(confirmations, "awaitResolution");

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-8",
        title: "Read the repository and summarize the layout",
        toolInput: {
          description: "Read the repository and summarize the layout",
          prompt: "Read every file and report back."
        },
        toolName: null
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: false,
      holdDurationMs: null
    });
    expect(store.created).toHaveLength(0);
    expect(awaitResolution).not.toHaveBeenCalled();
    expect(store.emitted).toHaveLength(0);
  });

  it("denies with the shared refusal wording when the hold expires", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store, 20);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-9",
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" },
        toolName: "Bash"
      })
    ).resolves.toMatchObject({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: true
    });
    expect(store.emitted.at(-1)).toMatchObject({
      kind: "action_result",
      outcome: "denied",
      reason: APPROVAL_REFUSED_REASON
    });
  });

  it("answers a pending ask as cancelled and records the cancellation", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store, 30_000);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-cancel",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));

    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "cancelled")).resolves.toBe(
      "resolved"
    );
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: true
    });
    expect((await pending).holdDurationMs).toBeGreaterThan(0);
    expect(store.emitted.at(-1)).toMatchObject({
      kind: "action_result",
      outcome: "denied",
      reason: "Action cancelled."
    });
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]).toMatchObject({ approvalMode: "cancelled", outcome: "failed" });
  });

  it("allows reads and in-folder writes with no card row", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-2",
        title: "Read src/index.ts",
        toolInput: { file_path: "src/index.ts" },
        toolName: "Read"
      })
    ).resolves.toMatchObject({ decision: "allow", asked: false, holdDurationMs: null });
    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-3",
        title: "Write src/out.txt",
        toolInput: { file_path: "src/out.txt" },
        toolName: "Write"
      })
    ).resolves.toMatchObject({ decision: "allow", asked: false, holdDurationMs: null });
    expect(store.created).toHaveLength(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("refuses the unrecognised with no card row and no retry wording", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-4",
        title: "Invent everything",
        toolInput: { whatever: true },
        toolName: "Skill"
      })
    ).resolves.toEqual({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: false,
      holdDurationMs: null
    });
    expect(store.created).toHaveLength(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("still allows when the person answers slowly, with no shorter clock firing", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store, 30_000);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-6",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));
    // The person takes two seconds; nothing on our side or the agent's side
    // cuts the wait short, so the late confirm still lands.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "confirmed")).resolves.toBe(
      "resolved"
    );
    await expect(pending).resolves.toMatchObject({
      decision: "allow",
      reason: "Approved by user.",
      asked: true
    });
    expect((await pending).holdDurationMs).toBeGreaterThanOrEqual(2000);
  });

  it("keeps a stopped turn cancelled after the next turn starts", async () => {
    const store = freshStore();
    const { gateway, tokens, confirmations } = buildGateway(store, 30_000);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    let releaseCreate!: () => void;
    store.createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    confirmations.beginTurn("agent-sess-1", "turn-old");
    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-old",
      toolCallId: "call-9",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.createStarted).toBe(true));
    expect(confirmations.cancelSession("agent-sess-1")).toBe(0);
    confirmations.beginTurn("agent-sess-1", "turn-new");
    store.createGate = undefined;
    releaseCreate();
    await vi.waitFor(() => expect(store.created).toHaveLength(1));
    expect(confirmations.isAwaiting("acp-action-1")).toBe(false);
    await expect(pending).resolves.toMatchObject({
      decision: "deny",
      reason: APPROVAL_REFUSED_REASON,
      asked: true
    });
    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "confirmed")).resolves.toBe(
      "expired"
    );

    const next = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-new",
      toolCallId: "call-next",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    await vi.waitFor(() => expect(store.created).toHaveLength(2));
    await vi.waitFor(() => expect(confirmations.isAwaiting("acp-action-2")).toBe(true));
    await expect(gateway.resolveActionRequest("u1", "acp-action-2", "confirmed")).resolves.toBe(
      "resolved"
    );
    await expect(next).resolves.toMatchObject({
      decision: "allow",
      reason: "Approved by user.",
      asked: true
    });
  });

  it("writes one audit line per ask and per refusal, none for silent allows", async () => {
    const ask = async (status: "confirmed" | "rejected", timeoutMs = 1000) => {
      const store = freshStore();
      const { gateway, tokens } = buildGateway(store, timeoutMs);
      const token = tokens.mint({
        actorUserId: "u1",
        chatSessionId: "s1",
        allowedToolNames: null
      });
      const pending = gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-9",
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" },
        toolName: "Bash"
      });
      await vi.waitFor(() => expect(store.created).toHaveLength(1));
      await expect(gateway.resolveActionRequest("u1", "acp-action-1", status)).resolves.toBe(
        "resolved"
      );
      await pending;
      return store.audit;
    };

    const confirmed = await ask("confirmed");
    expect(confirmed).toHaveLength(1);
    expect(confirmed[0]).toMatchObject({
      toolModuleId: "acp-builtin",
      toolName: "Bash",
      approvalMode: "confirmed",
      outcome: "success",
      errorClass: null
    });
    const rejected = await ask("rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      approvalMode: "rejected",
      outcome: "failed",
      errorClass: "rejected"
    });

    const store = freshStore();
    const { gateway, tokens } = buildGateway(store, 20);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    await gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-9",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" },
      toolName: "Bash"
    });
    expect(store.audit).toHaveLength(1);
    expect(store.audit[0]).toMatchObject({ approvalMode: "timeout", outcome: "failed" });

    const silent = freshStore();
    const silentGateway = buildGateway(silent);
    const silentToken = silentGateway.tokens.mint({
      actorUserId: "u1",
      chatSessionId: "s1",
      allowedToolNames: null
    });
    await silentGateway.gateway.requestAcpBuiltInPermission(silentToken, {
      cwd: CWD,
      home: "/home/agent",
      sessionId: "agent-sess-1",
      turnId: "turn-1",
      toolCallId: "call-2",
      title: "Read src/a.ts",
      toolInput: { file_path: "src/a.ts" },
      toolName: "Read"
    });
    expect(silent.audit).toHaveLength(0);
  });

  it("writes the reason word for each refusal class", async () => {
    const cases: Array<{
      input: Record<string, unknown>;
      toolName: string | null;
      reason: string;
    }> = [
      { input: {}, toolName: null, reason: "unknown_tool" },
      { input: {}, toolName: "DefinitelyNotATool", reason: "unknown_tool" },
      { input: {}, toolName: "Task", reason: "not_offered" },
      {
        input: { file_path: "/home/agent/.claude.json" },
        toolName: "Read",
        reason: "forbidden_zone"
      },
      { input: {}, toolName: "Read", reason: "malformed" }
    ];
    for (const refusal of cases) {
      const store = freshStore();
      const { gateway, tokens } = buildGateway(store);
      const token = tokens.mint({
        actorUserId: "u1",
        chatSessionId: "s1",
        allowedToolNames: null
      });
      await gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-9",
        title: "t",
        toolInput: refusal.input,
        toolName: refusal.toolName
      });
      expect(store.audit).toHaveLength(1);
      expect(store.audit[0]).toMatchObject({
        approvalMode: "auto",
        outcome: "failed",
        errorClass: refusal.reason
      });
    }
  });

  it("rejects a token it never minted", async () => {
    const store = freshStore();
    const { gateway } = buildGateway(store);
    await expect(
      gateway.requestAcpBuiltInPermission("jst_bogus", {
        cwd: CWD,
        home: "/home/agent",
        sessionId: "agent-sess-1",
        turnId: "turn-1",
        toolCallId: "call-5",
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" },
        toolName: "Bash"
      })
    ).rejects.toThrow(InvalidSessionTokenError);
  });
});

function gatewayResolveSoon(
  gateway: AssistantToolGateway,
  actorUserId: string,
  status: "confirmed" | "rejected" = "confirmed"
): void {
  setTimeout(() => {
    void gateway.resolveActionRequest(actorUserId, "acp-action-1", status).catch(() => undefined);
  }, 50);
}
