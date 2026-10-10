import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { CliChatDeliveryUnknownError } from "../../packages/chat/src/live/errors.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

// #3128: the live turn writes its in-flight record before the model receives the question,
// saves it away with the completed turn, and settles it when the turn never saves.

const replyScript = () => [
  { records: [{ kind: "reply", text: "done" }] as TranscriptRecord[], offset: 10, complete: true }
];

function recordingDeps(
  engine: FakeEngine,
  opts: { readonly incognito?: boolean; readonly beginFails?: boolean } = {},
  extraDeps: Partial<Parameters<typeof makeMinimalDeps>[0]> = {}
) {
  const events: string[] = [];
  const thread = { id: "thread-1", incognito: opts.incognito ?? false };
  const persistence = {
    resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
    listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
    recordTurn: vi.fn(async (...args: unknown[]) => {
      const turnOpts = args[4] as { turnId?: string };
      events.push(`record:${turnOpts.turnId}`);
      return { userMessageId: "m-user", assistantMessageId: "m-assistant" };
    }),
    openNewConversation: vi.fn().mockResolvedValue(undefined),
    getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
    touchExistingThread: vi.fn().mockResolvedValue(true),
    getCurrentThreadState: vi.fn().mockResolvedValue(thread),
    getMainThreadState: vi.fn().mockResolvedValue(thread),
    beginLiveTurn: vi.fn(async (_actor: string, turn: { turnId: string; userText: string }) => {
      events.push(`begin:${turn.turnId}:${turn.userText}`);
      if (opts.beginFails) throw new Error("database down");
    }),
    storeInterruptedLiveTurn: vi.fn(async (_actor: string, _threadId: string, turnId: string) => {
      events.push(`settle:${turnId}:interrupted`);
    }),
    discardLiveTurn: vi.fn(async (_actor: string, turnId: string) => {
      events.push(`settle:${turnId}:discard`);
    })
  };
  const originalSubmit = engine.submit.bind(engine);
  engine.submit = async (text: string) => {
    events.push("submit");
    await originalSubmit(text);
  };
  const deps = makeMinimalDeps({
    engineFactory: () => engine,
    pollMs: 0,
    persistence,
    ...extraDeps
  });
  return { deps, events, persistence };
}

function turnIdOf(events: readonly string[]): string {
  const begin = events.find((event) => event.startsWith("begin:"));
  return begin?.split(":")[1] ?? "";
}

describe("live turn in-flight record (#3128)", () => {
  it("writes the record before the model receives the question and saves it with the turn", async () => {
    const { deps, events, persistence } = recordingDeps(new FakeEngine(0, replyScript()));
    const manager = new ChatSessionManager(deps);

    const { reply } = await manager.submitTurn("u1", "Ben", "what is due today?");

    expect(reply).toBe("done");
    const turnId = turnIdOf(events);
    expect(turnId).not.toBe("");
    expect(events).toEqual([`begin:${turnId}:what is due today?`, "submit", `record:${turnId}`]);
    expect(persistence.storeInterruptedLiveTurn).not.toHaveBeenCalled();
    expect(persistence.discardLiveTurn).not.toHaveBeenCalled();
  });

  it("stores the question as interrupted when the reply fails after the model received it", async () => {
    class FailingReadEngine extends FakeEngine {
      override async readNew(): Promise<never> {
        throw new Error("engine died");
      }
    }
    const { deps, events, persistence } = recordingDeps(new FailingReadEngine());
    const manager = new ChatSessionManager(deps);

    await expect(manager.submitTurn("u1", "Ben", "send the report")).rejects.toThrow();

    const turnId = turnIdOf(events);
    expect(events).toEqual([
      `begin:${turnId}:send the report`,
      "submit",
      `settle:${turnId}:interrupted`
    ]);
    expect(persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("stores the question as interrupted when the model goes silent past the idle watchdog", async () => {
    let now = 0;
    const idleWatchdogMs = 500;
    class SilentEngine extends FakeEngine {
      override async readNew(afterOffset: number) {
        now += idleWatchdogMs + 100;
        return { records: [] as TranscriptRecord[], offset: afterOffset, complete: false };
      }
    }
    const { deps, events, persistence } = recordingDeps(
      new SilentEngine(),
      {},
      { idleWatchdogMs, clock: { now: () => now } }
    );
    const manager = new ChatSessionManager(deps);

    await manager.submitTurn("u1", "Ben", "check the boiler");

    expect(events.at(-1)).toBe(`settle:${turnIdOf(events)}:interrupted`);
    expect(persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("stores the question as interrupted, without resubmitting, when delivery is uncertain", async () => {
    class UncertainSubmitEngine extends FakeEngine {
      override async submit(): Promise<never> {
        throw new CliChatDeliveryUnknownError("chat input delivery is unknown");
      }
    }
    const { deps, events } = recordingDeps(new UncertainSubmitEngine());
    const manager = new ChatSessionManager(deps);

    await expect(manager.submitTurn("u1", "Ben", "pay the invoice")).rejects.toThrow(
      CliChatDeliveryUnknownError
    );

    const turnId = turnIdOf(events);
    expect(events).toEqual([
      `begin:${turnId}:pay the invoice`,
      "submit",
      `settle:${turnId}:interrupted`
    ]);
  });

  it("drops the record when the user stops the reply", async () => {
    class GatedEngine extends FakeEngine {
      private release: () => void = () => {};
      private readonly gate = new Promise<void>((resolve) => {
        this.release = resolve;
      });
      override async readNew(afterOffset: number) {
        await this.gate;
        return { records: [] as TranscriptRecord[], offset: afterOffset, complete: false };
      }
      override async interrupt(): Promise<void> {
        await super.interrupt();
        this.release();
      }
    }
    const { deps, events } = recordingDeps(new GatedEngine());
    const manager = new ChatSessionManager(deps);

    const turn = manager.submitTurn("u1", "Ben", "long question");
    await vi.waitFor(() => expect(events).toContain("submit"));
    await manager.stopTurn("u1");
    await turn;

    expect(events.at(-1)).toBe(`settle:${turnIdOf(events)}:discard`);
  });

  it("never records a private chat's question", async () => {
    class PrivateEngine extends FakeEngine {
      async purgeTranscripts(): Promise<void> {}
    }
    const { deps, persistence } = recordingDeps(new PrivateEngine(0, replyScript()), {
      incognito: true
    });
    const manager = new ChatSessionManager(deps);

    const { reply } = await manager.submitTurn("u1", "Ben", "private question");

    expect(reply).toBe("done");

    expect(persistence.beginLiveTurn).not.toHaveBeenCalled();
    expect(persistence.storeInterruptedLiveTurn).not.toHaveBeenCalled();
    expect(persistence.discardLiveTurn).not.toHaveBeenCalled();
  });

  it("still answers when the record cannot be written", async () => {
    const { deps, persistence } = recordingDeps(new FakeEngine(0, replyScript()), {
      beginFails: true
    });
    const manager = new ChatSessionManager(deps);

    const { reply } = await manager.submitTurn("u1", "Ben", "hello");

    expect(reply).toBe("done");
    expect(persistence.recordTurn).toHaveBeenCalledTimes(1);
    expect(persistence.storeInterruptedLiveTurn).not.toHaveBeenCalled();
    expect(persistence.discardLiveTurn).not.toHaveBeenCalled();
  });
});
