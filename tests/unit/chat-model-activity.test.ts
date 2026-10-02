/**
 * Plan 3.6b (#2890): live chat records one model activity row per turn, including CLI chat turns
 * the provider-adapter seam cannot see. One row per turn (inner tool calls are not visible), with
 * only transport facts: kind, action, outcome and the session's actual model. No message text.
 */
import { describe, expect, it } from "vitest";

import type { ProviderKind } from "../../packages/ai/src/index.js";
import {
  installModelActivityRecorder,
  type ModelActivityEntry
} from "../../packages/ai/src/model-activity.js";
import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { PersonaFs } from "../../packages/chat/src/live/persona.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";

const NOW = 1_725_000_000_000;

class FakeClock implements Clock {
  now(): number {
    return NOW;
  }
}

class FakePersistence implements ChatPersistencePort {
  active: { provider: ProviderKind; model: string } = {
    provider: "anthropic",
    model: "claude-x"
  };

  async resolveActiveProvider(): Promise<{ provider: ProviderKind; model: string }> {
    return this.active;
  }
  async listPriorTurns(): Promise<{ recent: never[]; oldSummary: null }> {
    return { recent: [], oldSummary: null };
  }
  async recordTurn(): Promise<{ userMessageId: string; assistantMessageId: string }> {
    return { userMessageId: "u1", assistantMessageId: "a1" };
  }
  async openNewConversation(): Promise<void> {}
  async getThreadContext(): Promise<{
    threadTitle: string | null;
    localTimezone: string | null;
    incognito: boolean;
  }> {
    return { threadTitle: null, localTimezone: null, incognito: false };
  }
  async touchExistingThread(): Promise<boolean> {
    return true;
  }
}

/** Completes one turn with a scripted reply. */
class OkEngine implements CliChatEngine {
  private pending: TranscriptRecord[] = [];
  constructor(public readonly provider: ProviderKind) {}
  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    this.pending = [{ kind: "reply", text: `reply to ${text}` }];
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    const records = this.pending;
    this.pending = [];
    return {
      records,
      offset: afterOffset + 1,
      complete: records.length > 0
    };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

/** Fails on the first read, so the turn throws after it started. */
class FailEngine implements CliChatEngine {
  constructor(public readonly provider: ProviderKind) {}
  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(): Promise<void> {}
  async readNew(): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    throw new Error("readNew failed");
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

const noopPersonaFs: PersonaFs = {
  async mkdir() {},
  async writeFile() {}
};

function makeManager(engine: CliChatEngine): ChatSessionManager {
  const persistence = new FakePersistence();
  const deps: ChatSessionManagerDeps = {
    engineFactory: () => engine,
    persistence,
    personaFs: noopPersonaFs,
    clock: new FakeClock(),
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "persona",
    pollMs: 0
  };
  return new ChatSessionManager(deps);
}

function collect(): { entries: ModelActivityEntry[]; restore: () => void } {
  const entries: ModelActivityEntry[] = [];
  installModelActivityRecorder((entry) => entries.push(entry));
  return { entries, restore: () => installModelActivityRecorder(null) };
}

describe("live chat model activity recording (plan 3.6b, #2890)", () => {
  it("records exactly one chat row per completed turn with the session's model", async () => {
    const { entries, restore } = collect();
    try {
      const manager = makeManager(new OkEngine("anthropic"));
      await manager.submitTurn("user-1", "Ben", "hello");
      await manager.submitTurn("user-1", "Ben", "again");

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        kind: "chat",
        action: "chat",
        outcome: "ok",
        modelName: "claude-x",
        result: "completed"
      });
    } finally {
      restore();
    }
  });

  it("records an error row when the turn throws, and never the message text", async () => {
    const { entries, restore } = collect();
    try {
      const SENTINEL = "SENTINEL-chat-message-do-not-record";
      const manager = makeManager(new FailEngine("anthropic"));
      await expect(manager.submitTurn("user-1", "Ben", SENTINEL)).rejects.toThrow("readNew failed");

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "chat", outcome: "error", result: "failed" });
      expect(JSON.stringify(entries)).not.toContain(SENTINEL);
    } finally {
      restore();
    }
  });

  it("records an aborted row when the caller stops the turn", async () => {
    const { entries, restore } = collect();
    try {
      // A gated engine that never completes, so the test can stop it mid-turn.
      let release!: (records: TranscriptRecord[]) => void;
      const gate = new Promise<TranscriptRecord[]>((resolve) => {
        release = resolve;
      });
      const engine: CliChatEngine = {
        provider: "anthropic" as ProviderKind,
        async launch() {
          return { offset: 0 };
        },
        async submit() {},
        async readNew(afterOffset: number) {
          const records = await gate;
          return { records, offset: afterOffset + 1, complete: true };
        },
        async isAlive() {
          return true;
        },
        async kill() {},
        async interrupt() {}
      };
      const manager = makeManager(engine);
      const turn = manager.submitTurn("user-1", "Ben", "stop me");
      await manager.stopTurn("user-1");
      release([]);
      await turn;

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "chat", outcome: "aborted", result: "stopped" });
    } finally {
      restore();
    }
  });
});
