import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";

// #1869: split out of tests/unit/chat-session-manager.test.ts, which sits at the
// check:file-size 1000-line cap — adding the time-context proof test there pushed it over.
// Reuses that file's `makeMinimalDeps` fixture (exported for exactly this reason) rather than
// drifting a second copy of it.
import { makeMinimalDeps } from "./chat-session-manager.test.js";

describe("ChatSessionManager.stopTurn — user-driven Stop (#456 Task C)", () => {
  /** Engine whose readNew blocks on a gate until the test releases it (models an in-flight turn
   *  the user interrupts mid-stream). */
  class GatedEngine {
    readonly provider = "anthropic" as const;
    launchOpts: EngineLaunchOpts | null = null;
    readonly submitted: string[] = [];
    interrupted = false;
    killed = false;
    private gate = new Promise<void>(() => {}); // never resolves by default
    private resolveGate: () => void = () => {};
    constructor() {
      this.gate = new Promise((r) => {
        this.resolveGate = r;
      });
    }
    async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
      this.launchOpts = opts;
      return { offset: 0 };
    }
    async submit(text: string): Promise<void> {
      this.submitted.push(text);
    }
    async readNew(
      afterOffset: number
    ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
      // Block until the test releases the gate (interrupt resolves it).
      await this.gate;
      if (this.killed) {
        throw new Error("engine killed");
      }
      return {
        records: [{ kind: "reply", text: "should-not-persist" }],
        offset: afterOffset + 10,
        complete: true
      };
    }
    async isAlive(): Promise<boolean> {
      return !this.killed;
    }
    async interrupt(): Promise<void> {
      this.interrupted = true;
      this.resolveGate();
    }
    async kill(): Promise<void> {
      this.killed = true;
      this.resolveGate();
    }
  }

  function stopDeps(engine: GatedEngine) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      pollMs: 0,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    });
  }

  it("stopTurn interrupts the active turn, keeps the engine alive, releases the turn lock, does not persist", async () => {
    const engine = new GatedEngine();
    const manager = new ChatSessionManager(stopDeps(engine));

    const received: TranscriptRecord[] = [];
    manager.subscribe("u1", (r) => received.push(r));

    const turnPromise = manager.submitTurn("u1", "Ben", "long running question");

    await new Promise((r) => setImmediate(r));

    await manager.stopTurn("u1");

    const { reply } = await turnPromise;
    expect(reply).toBe(""); // no partial reply persisted

    const stopStatus = received.find((r) => r.kind === "status" && r.text === "Stopped by user.");
    expect(stopStatus).toBeDefined();

    expect(engine.interrupted).toBe(true);
    expect(engine.killed).toBe(false);

    expect(
      (manager as unknown as { deps: { persistence: { recordTurn: ReturnType<typeof vi.fn> } } })
        .deps.persistence.recordTurn
    ).not.toHaveBeenCalled();

    const second = await manager.submitTurn("u1", "Ben", "next");
    expect(second.reply).toBe("should-not-persist");
  });

  it("stopTurn is idempotent (no-op when no turn in flight)", async () => {
    const manager = new ChatSessionManager(stopDeps(new GatedEngine()));
    const received: TranscriptRecord[] = [];
    manager.subscribe("u1", (r) => received.push(r));

    // No turn in flight — must not throw, must not emit anything.
    await expect(manager.stopTurn("u1")).resolves.toBeUndefined();
    expect(received).toHaveLength(0);
  });
});
