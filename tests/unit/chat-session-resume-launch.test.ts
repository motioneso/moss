import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatEngine } from "../../packages/chat/src/live/types.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(incognito: boolean) {
  const launchStarted = deferred();
  const releaseLaunch = deferred();
  let currentThread = { id: "origin-thread", incognito };
  const engines: CliChatEngine[] = [];
  const recordTurn = vi.fn(async () => ({ userMessageId: "user", assistantMessageId: "reply" }));
  const listPriorTurns = vi.fn(async () => ({ recent: [], oldSummary: null }));
  const openNewConversation = vi.fn(async () => {});
  const touchExistingThread = vi.fn(async (_owner: string, threadId: string) => {
    currentThread = { id: threadId, incognito: false };
    return true;
  });
  const manager = new ChatSessionManager({
    engineFactory: () => {
      const first = engines.length === 0;
      const engine: CliChatEngine = {
        provider: "anthropic",
        handlesOwnPrivatePurge: true,
        launch: vi.fn(async () => {
          if (first) {
            launchStarted.resolve();
            await releaseLaunch.promise;
          }
          return { offset: 0 };
        }),
        submit: vi.fn(async () => {}),
        readNew: vi.fn(async () => ({
          records: [{ kind: "reply" as const, text: "Scripted UAT-1105 reply." }],
          offset: 1,
          complete: true
        })),
        isAlive: vi.fn(async () => true),
        kill: vi.fn(async () => {}),
        interrupt: vi.fn(async () => {})
      };
      engines.push(engine);
      return engine;
    },
    persistence: {
      resolveActiveProvider: async () => ({ provider: "anthropic", model: "default" }),
      getCurrentThreadState: async () => ({ ...currentThread }),
      openNewConversation,
      listPriorTurns,
      getThreadContext: async () => ({
        threadTitle: null,
        localTimezone: null,
        incognito: currentThread.incognito
      }),
      touchExistingThread,
      recordTurn
    },
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    clock: { now: () => Date.now() },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "Assistant",
    pollMs: 0
  });
  return {
    manager,
    launchStarted,
    releaseLaunch,
    engines,
    recordTurn,
    listPriorTurns,
    openNewConversation,
    touchExistingThread,
    select: (id: string, privateMode: boolean) => {
      currentThread = { id, incognito: privateMode };
    }
  };
}

describe("conversation-bound session reuse", () => {
  it.each([true, false])(
    "relaunches one shared late engine after history resume (original private=%s)",
    async (incognito) => {
      const h = harness(incognito);
      // GET /stream begins this pre-start before History is clicked.
      const originalLaunch = h.manager.ensureSession("user-a", "User");
      await h.launchStarted.promise;
      await h.manager.resumeThread("user-a", "resumed-thread");
      const concurrentLaunch = h.manager.ensureSession("user-a", "User");
      h.releaseLaunch.resolve();
      const [original, concurrent] = await Promise.all([originalLaunch, concurrentLaunch]);
      expect(original).toBe(concurrent);
      expect(original.threadId).toBe("resumed-thread");
      expect(original.incognito).toBe(false);

      const response = await h.manager.submitTurn(
        "user-a",
        "User",
        "UAT-1105 continue in resumed thread"
      );
      expect(response).toMatchObject({ reply: "Scripted UAT-1105 reply." });
      expect(h.engines).toHaveLength(2);
      expect(h.engines[0]!.kill).toHaveBeenCalledOnce();
      expect(h.engines[0]!.submit).not.toHaveBeenCalled();
      expect(h.listPriorTurns).toHaveBeenLastCalledWith(
        "user-a",
        { forceReplay: true, threadId: "resumed-thread" },
        "drawer"
      );
      expect(h.openNewConversation).not.toHaveBeenCalled();
      expect(h.touchExistingThread).toHaveBeenCalledTimes(1);
      expect(h.recordTurn).toHaveBeenCalledWith(
        "user-a",
        "UAT-1105 continue in resumed thread",
        "Scripted UAT-1105 reply.",
        expect.anything(),
        expect.objectContaining({ threadId: "resumed-thread" }),
        "drawer"
      );
    }
  );

  it.each([
    { threadId: "different-thread", incognito: false },
    { threadId: "private-thread", incognito: true }
  ])(
    "keeps the warm selection after later activity in $threadId/privacy=$incognito",
    async (selected) => {
      const h = harness(false);
      h.releaseLaunch.resolve();
      const original = await h.manager.ensureSession("user-a", "User");
      h.select(selected.threadId, selected.incognito);

      const resumed = await h.manager.ensureSession("user-a", "User");

      expect(resumed).toBe(original);
      expect(resumed.threadId).toBe("origin-thread");
      expect(resumed.incognito).toBe(false);
      expect(h.engines).toHaveLength(1);
      expect(h.engines[0]!.kill).not.toHaveBeenCalled();
      expect(h.openNewConversation).not.toHaveBeenCalled();
      expect(h.touchExistingThread).not.toHaveBeenCalled();
    }
  );
});
