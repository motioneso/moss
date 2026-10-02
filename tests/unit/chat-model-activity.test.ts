/**
 * Plan 3.6b (#2890): live chat records one model activity row per turn, including CLI chat turns
 * the provider-adapter seam cannot see. `withTurnActivityRecording` wraps the session engine at the
 * composition seam, so the row is per turn (inner tool-loop calls are not visible). Only transport
 * facts are recorded — kind, action, outcome, the session's actual model. No message text.
 */
import { describe, expect, it } from "vitest";

import { installModelActivityRecorder, type ModelActivityEntry } from "@moss/ai";
import type { ProviderKind } from "@moss/ai";
import {
  ChatSessionManager,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { PersonaFs } from "../../packages/chat/src/live/persona.js";
import { withTurnActivityRecording } from "../../packages/chat/src/live/turn-activity-engine.js";
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
    return { records, offset: afterOffset + 1, complete: records.length > 0 };
  }
  async isAlive(): Promise<boolean> {
    return true;
  }
  async kill(): Promise<void> {}
  async interrupt(): Promise<void> {}
}

/** Fails on the first read, so the turn started but the model call failed. */
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

/** A manager whose engine factory records turn activity, mirroring the runtime composition seam. */
function makeManager(build: () => CliChatEngine): ChatSessionManager {
  const persistence = new FakePersistence();
  const deps: ChatSessionManagerDeps = {
    engineFactory: () => withTurnActivityRecording(build()),
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
      const manager = makeManager(() => new OkEngine("anthropic"));
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
      const manager = makeManager(() => new FailEngine("anthropic"));
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
      const manager = makeManager(() => engine);
      const turn = manager.submitTurn("user-1", "Ben", "stop me");
      // Give the turn time to submit before stopping it.
      await new Promise((resolve) => setTimeout(resolve, 20));
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

describe("turn wrapper state (plan 3.6b, #2890)", () => {
  it("does not double-log when a failed submit is retried and then completes", async () => {
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      let submitCount = 0;
      const engine: CliChatEngine = {
        provider: "anthropic" as ProviderKind,
        async launch() {
          return { offset: 0 };
        },
        async submit() {
          submitCount += 1;
          if (submitCount === 1) throw new Error("engine unavailable, never entered");
        },
        async readNew(afterOffset: number) {
          // One scripted reply, delivered on the first read after a successful submit.
          return {
            records: [{ kind: "reply", text: "ok" }],
            offset: afterOffset + 1,
            complete: true
          };
        },
        async isAlive() {
          return true;
        },
        async kill() {},
        async interrupt() {}
      };
      const wrapped = withTurnActivityRecording(engine);

      await expect(wrapped.submit("first")).rejects.toThrow("never entered");
      await wrapped.submit("retry");
      await wrapped.readNew(0);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "chat", outcome: "ok" });
    } finally {
      installModelActivityRecorder(null);
    }
  });

  it("logs an abandoned turn as error when the next submit starts first", async () => {
    const entries: ModelActivityEntry[] = [];
    installModelActivityRecorder((entry) => entries.push(entry));
    try {
      const engine: CliChatEngine = {
        provider: "anthropic" as ProviderKind,
        async launch() {
          return { offset: 0 };
        },
        async submit() {},
        async readNew(afterOffset: number) {
          return { records: [], offset: afterOffset, complete: false };
        },
        async isAlive() {
          return true;
        },
        async kill() {},
        async interrupt() {}
      };
      const wrapped = withTurnActivityRecording(engine);

      await wrapped.submit("turn one");
      // No terminal event; the manager abandons it and starts a new turn.
      await wrapped.submit("turn two");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ outcome: "error" });

      // The second turn completes.
      void wrapped;
      entries.length = 0;
    } finally {
      installModelActivityRecorder(null);
    }
  });
});
