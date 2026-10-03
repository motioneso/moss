import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import {
  createClassifierGateShadowRunner,
  type ClassifierGateShadowRunner
} from "../../packages/chat/src/live/classifier-gate-shadow.js";
import { FakeEngine, rejectingDeps } from "./chat-session-manager.test.js";
import type { ClassifierShadowRepository } from "../../packages/chat/src/classifier-shadow-repository.js";

/**
 * #2907 (plan 3.5) — the manager hook. `runTurn` starts one shadow attempt with the original text
 * and the turn's cancellation, reports only the FIRST real model tool record, and reports
 * no-model-tool when none ran. The shadow runner itself is a spy here.
 */

function shadow(): ClassifierGateShadowRunner & {
  start: ReturnType<typeof vi.fn>;
  observeModelTool: ReturnType<typeof vi.fn>;
  noModelTool: ReturnType<typeof vi.fn>;
  cancelTurn: ReturnType<typeof vi.fn>;
} {
  return {
    start: vi.fn(),
    observeModelTool: vi.fn(),
    noModelTool: vi.fn(),
    cancelTurn: vi.fn()
  } as never;
}

describe("ChatSessionManager classifier shadow hook (#2907)", () => {
  it("starts one shadow attempt with the original text and reports the first tool record", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          {
            kind: "tool",
            text: "listing events",
            toolName: "mcp__jarvis__calendar_listVisibleEvents"
          },
          { kind: "tool", text: "again", toolName: "mcp__jarvis__tasks_create" },
          { kind: "reply", text: "You have 3 events." }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const gate = shadow();
    const manager = new ChatSessionManager({
      ...rejectingDeps(engine),
      classifierGateShadow: gate
    } as never);

    await manager.submitTurn("u1", "Ben", "what is on my calendar today?");

    expect(gate.start).toHaveBeenCalledTimes(1);
    const started = gate.start.mock.calls[0]?.[0] as {
      actorUserId: string;
      message: string;
      hasAttachment: boolean;
      incognito: boolean;
      turnId: string;
    };
    expect(started).toMatchObject({
      actorUserId: "u1",
      message: "what is on my calendar today?",
      hasAttachment: false,
      incognito: false
    });
    expect(typeof started.turnId).toBe("string");
    // Only the FIRST tool attempt correlates; the later one is ignored.
    expect(gate.observeModelTool).toHaveBeenCalledTimes(1);
    expect(gate.observeModelTool).toHaveBeenCalledWith(
      "u1",
      started.turnId,
      "mcp__jarvis__calendar_listVisibleEvents"
    );
    expect(gate.noModelTool).not.toHaveBeenCalled();
  });

  it("reports no-model-tool when the turn answered without any tool", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "Hello." }], offset: 10, complete: true }
    ]);
    const gate = shadow();
    const manager = new ChatSessionManager({
      ...rejectingDeps(engine),
      classifierGateShadow: gate
    } as never);

    await manager.submitTurn("u1", "Ben", "hi");

    expect(gate.observeModelTool).not.toHaveBeenCalled();
    expect(gate.noModelTool).toHaveBeenCalledTimes(1);
  });

  it("a private turn whose user then switches to a normal chat records nothing", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "Hello." }], offset: 10, complete: true }
    ]);
    const open = vi.fn(async () => true);
    const repository = {
      open,
      complete: vi.fn(async () => true),
      observeModelTool: vi.fn(async () => true)
    } as unknown as ClassifierShadowRepository;
    const runner = createClassifierGateShadowRunner({
      readMode: async () => "shadow",
      createPorts: () => ({
        classifier: { resolve: async () => null, choose: vi.fn(), extract: vi.fn() },
        listTools: async () => [],
        loadCandidates: vi.fn(),
        isReleased: () => false,
        gateway: { call: vi.fn() }
      }),
      repository,
      dataContext: {
        withDataContext: async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
          work({})
      } as never,
      tokens: { mint: () => "jst_unused", revoke: () => {} },
      listToolNames: async () => [],
      thresholdVersion: "v1",
      now: () => 0
    });
    // The turn starts private; `engine.launch` flips the current thread to normal immediately
    // after the session is established, modelling a user who switches chats before the shadow
    // check. This catches a regression to reading the current thread at shadow time: then the
    // runner opens a record and the `open` assertion below fails. It does not assert how many
    // times the thread state is read.
    let privateNow = true;
    const getCurrentThreadState = vi.fn(async () => ({
      id: privateNow ? "private-thread" : "normal-thread",
      incognito: privateNow
    }));
    (engine as unknown as { handlesOwnPrivatePurge: boolean }).handlesOwnPrivatePurge = true;
    const originalLaunch = engine.launch.bind(engine);
    engine.launch = async (opts) => {
      const result = await originalLaunch(opts);
      privateNow = false;
      return result;
    };
    const baseDeps = rejectingDeps(engine) as unknown as {
      persistence: Record<string, unknown>;
    };
    const manager = new ChatSessionManager({
      ...(baseDeps as object),
      persistence: { ...baseDeps.persistence, getCurrentThreadState },
      classifierGateShadow: runner
    } as never);

    await manager.submitTurn("u1", "Ben", "private message that must not be recorded");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(open).not.toHaveBeenCalled();
  });

  it("does nothing when no shadow runner is wired", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "Hello." }], offset: 10, complete: true }
    ]);
    const manager = new ChatSessionManager(rejectingDeps(engine) as never);
    await expect(manager.submitTurn("u1", "Ben", "hi")).resolves.toMatchObject({ reply: "Hello." });
  });
});
