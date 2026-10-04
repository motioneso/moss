/**
 * #2956 slice B: live chat records one owned answer line per completed turn.
 * The manager mints the turn id once where the turn starts, so the shadow
 * record, the audit rows, the check lines and the answer line share one value,
 * and writes the line (with that id) when the turn stores. Turns that never
 * store — failed, stopped, private — write no line; their steps reference a
 * missing parent, by design.
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
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";

const NOW = 1_725_000_000_000;

class FakeClock implements Clock {
  now(): number {
    return NOW;
  }
}

class FakePersistence implements ChatPersistencePort {
  constructor(private readonly store = true) {}

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
  async recordTurn(): Promise<{ userMessageId: string; assistantMessageId: string } | undefined> {
    if (!this.store) return undefined;
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

function makeManager(
  build: () => CliChatEngine,
  seen: { setCalls: Array<[string, string]>; clearCalls: string[] },
  store = true
): ChatSessionManager {
  const deps: ChatSessionManagerDeps = {
    engineFactory: () => build(),
    persistence: new FakePersistence(store),
    personaFs: noopPersonaFs,
    clock: new FakeClock(),
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "persona",
    pollMs: 0,
    setCurrentTurnId: (sessionId, turnId) => seen.setCalls.push([sessionId, turnId]),
    clearCurrentTurnId: (sessionId) => seen.clearCalls.push(sessionId)
  };
  return new ChatSessionManager(deps);
}

function collect(): {
  entries: ModelActivityEntry[];
  seen: { setCalls: Array<[string, string]>; clearCalls: string[] };
  restore: () => void;
} {
  const entries: ModelActivityEntry[] = [];
  installModelActivityRecorder((entry) => entries.push(entry));
  return {
    entries,
    seen: { setCalls: [], clearCalls: [] },
    restore: () => installModelActivityRecorder(null)
  };
}

describe("chat answer lines (#2956 slice B)", () => {
  it("writes one owned chat.answer line per completed turn, keyed by the turn id", async () => {
    const { entries, seen, restore } = collect();
    try {
      const manager = makeManager(() => new OkEngine("anthropic"), seen);
      await manager.submitTurn("user-1", "Ben", "hello");
      await manager.submitTurn("user-1", "Ben", "again");

      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry).toMatchObject({
          kind: "chat",
          action: "chat",
          actionCode: "chat.answer",
          outcome: "ok",
          modelName: "claude-x",
          result: "completed",
          ownerUserId: "user-1"
        });
        // One id for the row, the turn link and the steps' parent.
        expect(typeof entry.id).toBe("string");
        expect(entry.turnId).toBe(entry.id);
      }
      expect(entries[0]?.id).not.toBe(entries[1]?.id);
      // The turn is filed while it runs and released when it ends.
      expect(seen.setCalls).toHaveLength(2);
      expect(seen.clearCalls).toHaveLength(2);
      expect(seen.setCalls[0]?.[1]).toBe(entries[0]?.id);
    } finally {
      restore();
    }
  });

  it("records tool counts, tokens, duration and steps; message words stay in owner detail", async () => {
    const { entries, seen, restore } = collect();
    try {
      const engine = new OkEngine("anthropic");
      const manager = makeManager(() => engine, seen);
      const SENTINEL = "SENTINEL-chat-message-stays-in-detail";
      await manager.submitTurn("user-1", "Ben", SENTINEL);

      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry.factCounts).toMatchObject({ tools: 0, tools_failed: 0 });
      // The bare line carries no message words; the quoted words ride the
      // owner-only detail row, which expires after 30 days.
      const bare = { ...entry, detail: undefined };
      expect(JSON.stringify(bare)).not.toContain(SENTINEL);
      expect(entry.detail?.quote).toBe(SENTINEL);
      expect(entry.detail?.steps?.at(-1)).toMatchObject({ title: "Answer" });
    } finally {
      restore();
    }
  });

  it("stores templated step words only: thinking, tool text and the reply never land", async () => {
    const { entries, seen, restore } = collect();
    try {
      const engine: CliChatEngine = {
        provider: "anthropic" as ProviderKind,
        async launch() {
          return { offset: 0 };
        },
        async submit() {},
        async readNew(afterOffset: number) {
          return {
            records: [
              { kind: "thinking", text: "SECRET-thinking-reasoning" },
              {
                kind: "tool",
                text: "SECRET-tool-output-words",
                toolName: "calendar.list",
                outcome: "executed"
              },
              { kind: "reply", text: "SECRET-reply-words" }
            ],
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
      const manager = makeManager(() => engine, seen);
      await manager.submitTurn("user-1", "Ben", "what is on today");

      expect(entries).toHaveLength(1);
      const steps = entries[0]!.detail?.steps ?? [];
      // Thinking is skipped; the tool and answer steps keep titles only.
      expect(steps.map((step) => step.title)).toEqual(["calendar.list", "Answer"]);
      const dumped = JSON.stringify(steps);
      expect(dumped).not.toContain("SECRET-thinking-reasoning");
      expect(dumped).not.toContain("SECRET-tool-output-words");
      expect(dumped).not.toContain("SECRET-reply-words");
      // Templated results name the outcome, never the text.
      expect(steps[0]?.result).toMatch(/^Finished\./);
      expect(steps[1]?.result).toMatch(/^Answered\./);
    } finally {
      restore();
    }
  });

  it("counts tools, tokens and duration, and names each step", async () => {
    const { entries, seen, restore } = collect();
    try {
      const engine: CliChatEngine = {
        provider: "anthropic" as ProviderKind,
        async launch() {
          return { offset: 0 };
        },
        async submit() {},
        async readNew(afterOffset: number) {
          return {
            records: [
              { kind: "tool", text: "calendar.list, today", toolName: "calendar.list" },
              {
                kind: "reply",
                text: "Found 2 events.",
                elapsedMs: 6200,
                usage: { inputTokens: 100, outputTokens: 50 }
              }
            ],
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
      const manager = makeManager(() => engine, seen);
      await manager.submitTurn("user-1", "Ben", "what is on today");

      expect(entries).toHaveLength(1);
      const entry = entries[0]!;
      expect(entry).toMatchObject({
        durationMs: 6200,
        inputTokens: 100,
        outputTokens: 50,
        factCounts: { tools: 1, tools_failed: 0 }
      });
      expect(entry.detail?.steps).toMatchObject([{ title: "calendar.list" }, { title: "Answer" }]);
    } finally {
      restore();
    }
  });

  it("writes no line when the turn fails, and the error still surfaces", async () => {
    const { entries, seen, restore } = collect();
    try {
      const manager = makeManager(() => new FailEngine("anthropic"), seen);
      await expect(manager.submitTurn("user-1", "Ben", "hello")).rejects.toThrow("readNew failed");
      expect(entries).toHaveLength(0);
      // The filing slot is still released.
      expect(seen.clearCalls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("writes no line when the caller stops the turn", async () => {
    const { entries, seen, restore } = collect();
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
      const manager = makeManager(() => engine, seen);
      const turn = manager.submitTurn("user-1", "Ben", "stop me");
      await new Promise((resolve) => setTimeout(resolve, 20));
      await manager.stopTurn("user-1");
      release([]);
      await turn;

      expect(entries).toHaveLength(0);
      expect(seen.clearCalls).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("writes no line when the turn is not stored (private turns persist nothing)", async () => {
    const { entries, seen, restore } = collect();
    try {
      const manager = makeManager(() => new OkEngine("anthropic"), seen, false);
      await manager.submitTurn("user-1", "Ben", "hello");
      expect(entries).toHaveLength(0);
      expect(seen.clearCalls).toHaveLength(1);
    } finally {
      restore();
    }
  });
});
