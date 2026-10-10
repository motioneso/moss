import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatEngine, EngineLaunchOpts } from "../../packages/chat/src/live/types.js";
import {
  admissionFixture,
  admissionTool,
  rejectAdmissionCard
} from "./helpers/gateway-admission-fixture.js";
import { makeMinimalDeps } from "./chat-session-manager.test.js";

// #3335: a resumed thread relaunches with a replay of its history. The model must not act on an
// old request in that history, because no user turn stands behind the replay. These tests drive a
// real token registry and gateway through the chat launch, with a model that tries a tool call
// while it reads the replay.

const reminderTool = () =>
  admissionTool("tasks.create", { risk: "destructive", summarize: () => "Create task" });

const history = {
  recent: [
    { role: "user" as const, content: "remind me in 3 minutes to stretch" },
    { role: "assistant" as const, content: "I'll remind you in 3 minutes to stretch." }
  ],
  oldSummary: null
};

/** A model that tries the reminder tool whenever it is handed a replay or a message. */
class ActingEngine implements CliChatEngine {
  readonly provider = "anthropic" as const;
  readonly calls: Promise<unknown>[] = [];
  launchOpts: EngineLaunchOpts | null = null;
  launchCount = 0;

  constructor(
    private readonly act: () => Promise<unknown>,
    private readonly replaysInsideLaunch: boolean
  ) {}

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    this.launchCount += 1;
    if (this.replaysInsideLaunch && opts.replayBatch) await this.respond();
    return { offset: 0 };
  }
  async submit(): Promise<void> {
    await this.respond();
  }
  async readNew(offset: number) {
    return { records: [], offset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}

  private async respond(): Promise<void> {
    const call = this.act();
    this.calls.push(call);
    await Promise.race([call, new Promise((resolve) => setTimeout(resolve, 20))]);
  }
}

function harness(serverOwnsDrain: boolean) {
  const tool = reminderTool();
  const h = admissionFixture([tool], { deps: { yoloMode: async () => false } });
  const engine = new ActingEngine(
    () => h.gateway.callTool(h.token, tool.name, {}),
    serverOwnsDrain
  );
  const revokeMcpToken = vi.fn();
  const deps = makeMinimalDeps({
    engineFactory: () => engine,
    pollMs: 0,
    serverOwnsDrain,
    mintMcpToken: vi.fn(async () => ({ token: h.token, mcpServerUrl: "http://mcp.test" })),
    revokeMcpToken,
    beginLaunchReplay: (token: string) => h.tokens.beginLaunchReplay(token),
    endLaunchReplay: (token: string) => h.tokens.endLaunchReplay(token),
    persistence: {
      resolveActiveProvider: vi.fn(async () => ({
        provider: "anthropic" as const,
        model: "test-model"
      })),
      listPriorTurns: vi.fn(async () => history),
      recordTurn: vi.fn(async () => undefined),
      openNewConversation: vi.fn(async () => undefined),
      getCurrentThreadState: vi.fn(async () => ({ id: "thread-a", incognito: false })),
      getThreadContext: vi.fn(async () => ({
        threadTitle: null,
        localTimezone: null,
        incognito: false
      })),
      touchExistingThread: vi.fn(async () => true)
    }
  });
  return { h, tool, engine, revokeMcpToken, manager: new ChatSessionManager(deps as never) };
}

describe("a resumed chat replaying a code-answered request", () => {
  it.each([
    ["the manager submits the replay", false],
    ["the server replays inside launch", true]
  ])("refuses the model's tool call while %s", async (_label, serverOwnsDrain) => {
    const { h, tool, engine, manager } = harness(serverOwnsDrain);
    await manager.resumeThread("actor-a", "thread-a");
    await manager.ensureSession("actor-a", "Ben");

    expect(engine.launchOpts?.replayBatch).toContain("remind me in 3 minutes to stretch");
    expect(engine.calls).toHaveLength(1);
    expect(await engine.calls[0]).toMatchObject({ ok: false });
    expect(tool.execute).not.toHaveBeenCalled();
    expect(h.records).toEqual([]);
    expect(h.createPending).not.toHaveBeenCalled();
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.tokens.isInLaunchReplay(h.token)).toBe(false);
  });

  it("lets the next real message raise the usual card", async () => {
    const { h, engine, manager } = harness(false);
    await manager.resumeThread("actor-a", "thread-a");
    await manager.ensureSession("actor-a", "Ben");

    const turn = manager.submitTurn("actor-a", "Ben", "add stretching to my task list");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2), { interval: 1 });
    await rejectAdmissionCard(h, engine.calls[1]!);
    await turn;
    expect(h.records.map((record) => record.kind)).toEqual(["action_request", "action_result"]);
  });

  it("relaunches cleanly after a replay that failed to drain", async () => {
    const { h, engine, revokeMcpToken, manager } = harness(false);
    vi.spyOn(engine, "readNew").mockRejectedValueOnce(new Error("engine exited"));
    const kill = vi.spyOn(engine, "kill");
    await manager.resumeThread("actor-a", "thread-a");
    revokeMcpToken.mockClear();
    await expect(manager.ensureSession("actor-a", "Ben")).rejects.toThrow("engine exited");
    expect(revokeMcpToken).toHaveBeenCalledWith("actor-a:drawer");
    expect(kill).toHaveBeenCalledTimes(1);

    await manager.ensureSession("actor-a", "Ben");
    expect(engine.launchCount).toBe(2);
    expect(h.tokens.isInLaunchReplay(h.token)).toBe(false);
  });

  it("refuses the replay even when a real message starts the session", async () => {
    const { h, engine, manager } = harness(false);

    const turn = manager.submitTurn("actor-a", "Ben", "add stretching to my task list");
    await vi.waitFor(() => expect(engine.calls).toHaveLength(2), { interval: 1 });
    expect(await engine.calls[0]).toMatchObject({ ok: false });
    await rejectAdmissionCard(h, engine.calls[1]!);
    await turn;
    expect(h.createPending).toHaveBeenCalledTimes(1);
    expect(h.records.map((record) => record.kind)).toEqual(["action_request", "action_result"]);
  });
});
