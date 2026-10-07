import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { ChatSessionManagerDeps } from "../../packages/chat/src/live/chat-session-manager.js";

function setup(): { manager: ChatSessionManager; listPriorTurns: ReturnType<typeof vi.fn> } {
  const listPriorTurns = vi.fn().mockResolvedValue({ recent: [], oldSummary: null });
  const engine = {
    launch: vi.fn().mockResolvedValue({ offset: 0 }),
    submit: vi.fn(),
    readNew: vi.fn(),
    kill: vi.fn()
  };
  const manager = new ChatSessionManager({
    engineFactory: vi.fn().mockReturnValue(engine),
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "claude" }),
      listPriorTurns,
      recordTurn: vi.fn(),
      openNewConversation: vi.fn(),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn()
    },
    personaFs: { mkdir: vi.fn(), writeFile: vi.fn() },
    clock: { now: () => 0 },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "Jarvis",
    pollMs: 0
  } satisfies ChatSessionManagerDeps);
  return { manager, listPriorTurns };
}

describe("ChatSessionManager switch replay", () => {
  it("forces replay lookup when switching provider/model", async () => {
    const { manager, listPriorTurns } = setup();

    await manager.ensureSession("user-1", "User");
    await manager.switchProvider("user-1", "User");

    expect(listPriorTurns).toHaveBeenLastCalledWith(
      "user-1",
      { forceReplay: true, threadId: null },
      "drawer"
    );
  });
});
