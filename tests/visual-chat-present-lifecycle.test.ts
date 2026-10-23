import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../packages/chat/src/live/chat-session-manager.js";
import type { TranscriptRecord } from "../packages/chat/src/live/types.js";
import {
  VisualPresentationService,
  type VisualPresentationTurn
} from "../packages/chat/src/visual/presentation-service.js";
import { FakeEngine, makeMinimalDeps } from "./unit/chat-session-manager.test.js";
import { surfaceSessionKey } from "../packages/chat/src/live/chat-surface.js";

const sessionId = surfaceSessionKey("u1");
const proposal = {
  catalogVersion: "moss.v1",
  blocks: [{ kind: "composition", snapshotRefs: [], program: "root = Reply()" }]
};

function fixture(
  outcome: "saved" | "unsaved" | "save-error" | "submit-error" | "read-error" | "cancel" = "saved"
) {
  const service = new VisualPresentationService();
  const begin = vi.spyOn(service, "begin");
  let turn: VisualPresentationTurn | undefined;
  let presented = false;
  let stateAtInterrupt: string | undefined;
  let releaseRead!: () => void;
  let submitted!: () => void;
  const ready = new Promise<void>((resolve) => {
    submitted = resolve;
  });
  const paused = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  let close: ReturnType<typeof vi.spyOn> | undefined;
  class Engine extends FakeEngine {
    override async submit(text: string) {
      await super.submit(text);
      turn = begin.mock.results.at(-1)?.value;
      if (!turn) throw new Error("missing presentation turn");
      close = vi.spyOn(turn, "close");
      expect(turn.registry.state).toBe("open");
      const result = service.present(
        {
          ...turn.identity,
          chatSessionId: sessionId,
          requestId: "request"
        },
        proposal
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.reply.fallbackText).toContain('"text":"six hours"');
      presented = true;
      submitted();
      if (outcome === "submit-error") throw new Error("submit failed");
    }
    override async readNew(afterOffset: number) {
      if (outcome === "read-error") throw new Error("read failed");
      if (outcome === "cancel") await paused;
      return {
        records: [{ kind: "reply", text: "ordinary answer" }] as TranscriptRecord[],
        offset: afterOffset + 1,
        complete: true
      };
    }
    override async interrupt() {
      await super.interrupt();
      stateAtInterrupt = turn?.registry.state;
      releaseRead();
    }
  }
  const engine = new Engine();
  const recordTurn = vi.fn(async () => {
    expect(turn?.registry.state).toBe("open");
    expect(turn?.reply).toBeDefined();
    if (outcome === "save-error") throw new Error("save failed");
    return outcome === "unsaved"
      ? undefined
      : { userMessageId: "user", assistantMessageId: "assistant" };
  });
  const thread = { id: "thread-1", incognito: false };
  const deps = makeMinimalDeps({
    engineFactory: () => engine,
    visualPresentation: service,
    pollMs: 0,
    persistence: {
      resolveActiveProvider: vi
        .fn()
        .mockResolvedValue({ provider: "anthropic", model: "configured" }),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn,
      openNewConversation: vi.fn(),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true),
      getCurrentThreadState: vi.fn().mockResolvedValue(thread),
      getMainThreadState: vi.fn().mockResolvedValue(thread)
    }
  });
  return {
    service,
    begin,
    engine,
    recordTurn,
    ready,
    deps,
    manager: new ChatSessionManager(deps),
    turn: () => turn,
    close: () => close,
    presented: () => presented,
    stateAtInterrupt: () => stateAtInterrupt
  };
}

describe("internal presentation turn lifecycle", () => {
  it("uses host identity, creates one registry, closes only after save and releases binding", async () => {
    const f = fixture();
    expect(await f.manager.submitTurn("u1", "User", "six hours")).toMatchObject({
      reply: "ordinary answer"
    });
    expect(f.begin).toHaveBeenCalledOnce();
    expect(f.begin.mock.calls[0]).toEqual([
      sessionId,
      {
        actorUserId: "u1",
        threadId: "thread-1",
        turnId: expect.any(String)
      }
    ]);
    expect(f.close()).toHaveBeenCalledOnce();
    expect(f.turn()?.registry.state).toBe("closed");
    expect(f.turn()?.reply).toBeUndefined();
    expect(f.recordTurn.mock.calls[0]).toBeDefined();
    expect(JSON.stringify(f.recordTurn.mock.calls)).not.toContain("visualReply");
    expect(
      f.service.present(
        { ...f.turn()!.identity, chatSessionId: sessionId, requestId: "late" },
        proposal
      ).ok
    ).toBe(false);
  });

  it.each(["unsaved", "save-error", "submit-error", "read-error"] as const)(
    "discards pending output on %s without retry",
    async (outcome) => {
      const f = fixture(outcome);
      const run = f.manager.submitTurn("u1", "User", "six hours");
      if (outcome === "unsaved") await run;
      else await expect(run).rejects.toThrow();
      expect(f.begin).toHaveBeenCalledOnce();
      expect(f.presented()).toBe(true);
      expect(f.engine.submitted).toHaveLength(1);
      expect(f.close()).not.toHaveBeenCalled();
      expect(f.turn()?.registry.state).toBe("discarded");
      expect(f.turn()?.reply).toBeUndefined();
    }
  );

  it("discards on user cancellation without saving or resubmitting", async () => {
    const f = fixture("cancel");
    const run = f.manager.submitTurn("u1", "User", "six hours");
    await Promise.race([f.ready, run]);
    await f.manager.stopTurn("u1");
    await run;
    expect(f.stateAtInterrupt()).toBe("discarded");
    expect(f.recordTurn).not.toHaveBeenCalled();
    expect(f.engine.submitted).toHaveLength(1);
    expect(f.turn()?.registry.state).toBe("discarded");
    expect(f.turn()?.reply).toBeUndefined();
  });

  it("keeps existing text turns working when no presentation service is injected", async () => {
    const f = fixture();
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "text only" }], offset: 1, complete: true }
    ]);
    const manager = new ChatSessionManager({
      ...f.deps,
      visualPresentation: undefined,
      engineFactory: () => engine,
      persistence: { ...f.deps.persistence, recordTurn: vi.fn() }
    });
    expect(await manager.submitTurn("u1", "User", "hello")).toMatchObject({ reply: "text only" });
    expect(f.begin).not.toHaveBeenCalled();
  });
});
