import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";

class FakeEngine {
  readonly provider = "openai-compatible" as const;
  launchOpts: EngineLaunchOpts | null = null;

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    return { offset: 0 };
  }
  async submit(_text: string): Promise<void> {}
  async readNew(afterOffset: number): Promise<{
    records: TranscriptRecord[];
    offset: number;
    complete: boolean;
  }> {
    return { records: [], offset: afterOffset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

describe("ChatSessionManager OpenCode model launch", () => {
  it("passes the saved OpenCode model through to the ACP launch", async () => {
    const engine = new FakeEngine();
    const deps = {
      engineFactory: () => engine,
      persona: "You are Jarvis.",
      personaFs: {
        mkdir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined)
      },
      clock: { now: () => Date.now() },
      idleMs: 60_000,
      neutralBase: "/tmp",
      persistence: {
        resolveActiveProvider: vi.fn().mockResolvedValue({
          provider: "openai-compatible",
          model: "default",
          acpModel: "muse-spark-1.3-free"
        }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn(),
        openNewConversation: vi.fn(),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    } as never;
    const manager = new ChatSessionManager(deps);

    await manager.ensureSession("u1", "Ben");

    expect(engine.launchOpts?.acpModel).toBe("muse-spark-1.3-free");
  });
});
