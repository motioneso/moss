import { describe, expect, it, vi } from "vitest";

import {
  APPROVAL_REFUSED_REASON,
  AssistantToolGateway,
  ConfirmationRegistry,
  InvalidSessionTokenError,
  SessionTokenRegistry
} from "@moss/ai";
import { decideAcpPermission, MossAcpClient, type AcpTunnel } from "@moss/acp";

const CWD = "/runner/session/acp/proj";

interface FakeStore {
  created: unknown[];
  emitted: unknown[];
  actionRow: { id: string; status: string };
}

function buildGateway(store: FakeStore, confirmTimeoutMs = 1000) {
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const gateway = new AssistantToolGateway({
    resolveActiveModules: async () => [],
    repository: {
      createPendingAssistantAction: async (_db: unknown, input: unknown) => {
        store.created.push(input);
        return { ...store.actionRow };
      },
      getAssistantAction: async () => ({ ...store.actionRow }),
      resolveAssistantAction: async () => ({ ...store.actionRow })
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
  return { created: [], emitted: [], actionRow: { id: "acp-action-1", status: "pending" } };
}

/** Scripted stand-in for the adapter: answers the handshake and permission asks. */
class ScriptedAgent implements AcpTunnel {
  readonly sent: string[] = [];
  private readonly outbox: string[] = [];
  private seq = 0;

  async spawn(): Promise<{ cwd: string; generation: number }> {
    return { cwd: CWD, generation: 1 };
  }

  async send(_sessionKey: string, line: string): Promise<void> {
    this.sent.push(line);
    const msg = JSON.parse(line) as { id?: number; method?: string };
    if (msg.method === "initialize") {
      this.emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { mcpCapabilities: { http: true } }
        }
      });
    } else if (msg.method === "session/new") {
      this.emit({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "agent-sess-1" } });
    }
  }

  async read(_sessionKey: string, afterSeq: number) {
    const lines = this.outbox.slice(afterSeq);
    return { lines, firstSeq: afterSeq + 1, nextSeq: this.seq, exited: false, truncated: false };
  }

  async kill(): Promise<void> {}

  async execStart(): Promise<{ execId: number }> {
    return { execId: 1 };
  }

  async execPoll() {
    return {
      output: "",
      done: true,
      exitCode: 0 as number | null,
      truncated: false,
      timedOut: false
    };
  }

  async execKill(): Promise<void> {}

  agentAsksPermission(id: number): void {
    this.emit({
      jsonrpc: "2.0",
      id,
      method: "session/request_permission",
      params: {
        sessionId: "agent-sess-1",
        toolCall: {
          toolCallId: "call-9",
          title: "`pnpm build`",
          rawInput: { command: "pnpm build" }
        },
        options: [
          { kind: "allow_always", name: "Always Allow", optionId: "allow_always" },
          { kind: "allow_once", name: "Allow", optionId: "allow" },
          { kind: "reject_once", name: "Reject", optionId: "reject" }
        ]
      }
    });
  }

  private emit(message: unknown): void {
    this.outbox.push(JSON.stringify(message));
    this.seq += 1;
  }
}

describe("agent built-in permission through the shared approval card", () => {
  it("raises the same card row and event as native asks, owned by the token actor", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    const pending = gateway.requestAcpBuiltInPermission(token, {
      cwd: CWD,
      sessionId: "agent-sess-1",
      toolCallId: "call-9",
      title: "`pnpm build`",
      toolInput: { command: "pnpm build" }
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

    await expect(pending).resolves.toEqual({ decision: "allow", reason: "Approved by user." });
    await vi.waitFor(() => expect(store.emitted).toHaveLength(2));
    expect(store.emitted[1]).toMatchObject({
      kind: "action_result",
      actionRequestId: "acp-action-1",
      toolName: "Bash",
      outcome: "allowed"
    });
  });

  it("denies with the shared refusal wording when the hold expires", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store, 20);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        sessionId: "agent-sess-1",
        toolCallId: "call-9",
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" }
      })
    ).resolves.toEqual({ decision: "deny", reason: APPROVAL_REFUSED_REASON });
    expect(store.emitted.at(-1)).toMatchObject({
      kind: "action_result",
      outcome: "denied",
      reason: APPROVAL_REFUSED_REASON
    });
  });

  it("allows reads and in-folder writes with no card row", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });

    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        sessionId: "agent-sess-1",
        toolCallId: "call-2",
        title: "Read src/index.ts",
        toolInput: { file_path: "src/index.ts" }
      })
    ).resolves.toMatchObject({ decision: "allow" });
    await expect(
      gateway.requestAcpBuiltInPermission(token, {
        cwd: CWD,
        sessionId: "agent-sess-1",
        toolCallId: "call-3",
        title: "Write src/out.txt",
        toolInput: { file_path: "src/out.txt" }
      })
    ).resolves.toMatchObject({ decision: "allow" });
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
        sessionId: "agent-sess-1",
        toolCallId: "call-4",
        title: "Invent everything",
        toolInput: { whatever: true }
      })
    ).resolves.toEqual({ decision: "deny", reason: APPROVAL_REFUSED_REASON });
    expect(store.created).toHaveLength(0);
    expect(store.emitted).toHaveLength(0);
  });

  it("rejects a token it never minted", async () => {
    const store = freshStore();
    const { gateway } = buildGateway(store);
    await expect(
      gateway.requestAcpBuiltInPermission("jst_bogus", {
        cwd: CWD,
        sessionId: "agent-sess-1",
        toolCallId: "call-5",
        title: "`pnpm build`",
        toolInput: { command: "pnpm build" }
      })
    ).rejects.toThrow(InvalidSessionTokenError);
  });

  it("runs an attended approval end to end: agent asks, person confirms, agent may proceed", async () => {
    const store = freshStore();
    const { gateway, tokens } = buildGateway(store);
    const token = tokens.mint({ actorUserId: "u1", chatSessionId: "s1", allowedToolNames: null });
    const agent = new ScriptedAgent();
    const client = new MossAcpClient(
      agent,
      {},
      {
        decide: async (permissionRequest, session) =>
          decideAcpPermission(permissionRequest, session.cwd, async (builtIn) => {
            const verdict = await gateway.requestAcpBuiltInPermission(token, {
              cwd: session.cwd,
              sessionId: builtIn.sessionId,
              toolCallId: builtIn.toolCallId,
              title: builtIn.title,
              toolInput:
                builtIn.rawInput && typeof builtIn.rawInput === "object"
                  ? (builtIn.rawInput as Record<string, unknown>)
                  : {},
              kind: builtIn.kind ?? null,
              paths: null
            });
            return verdict.decision === "allow" ? "allow" : "deny";
          })
      }
    );
    const handle = await client.openSession("workshop:u1:proj", "proj");
    agent.agentAsksPermission(11);

    // The card is up; the person confirms through the Approve path.
    await vi.waitFor(() => expect(store.emitted).toHaveLength(1));
    await expect(gateway.resolveActionRequest("u1", "acp-action-1", "confirmed")).resolves.toBe(
      "resolved"
    );

    await vi.waitFor(() => {
      const answers = agent.sent
        .map((line) => JSON.parse(line))
        .filter((msg) => msg.id === 11 && msg.result !== undefined);
      expect(answers.length).toBe(1);
    });
    const answer = agent.sent
      .map((line) => JSON.parse(line))
      .find((msg) => msg.id === 11 && msg.result !== undefined);
    expect(answer.result.outcome).toEqual({ outcome: "selected", optionId: "allow" });
    await client.close(handle);
  });
});
