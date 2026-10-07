import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type {
  ChatSessionManagerDeps,
  ChatPersistencePort
} from "../../packages/chat/src/live/chat-session-manager.js";

const THREAD_ID = "00000000-0000-4000-8000-000000000071";

const soonIso = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();
const overdueIso = () => new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

function makeCrossToolRead() {
  return {
    runReadTool: vi.fn(async (_actor: string, toolName: string) => {
      if (toolName === "tasks.focus") {
        return {
          ok: true,
          data: { items: [{ title: "Write quarterly report", dueAt: overdueIso() }] }
        };
      }
      if (toolName === "tasks.atRisk" || toolName === "tasks.overdue") {
        return { ok: true, data: { items: [] } };
      }
      if (toolName === "calendar.listVisibleEvents") {
        return {
          ok: true,
          data: {
            events: [{ title: "Today work sync", starts_at: soonIso(), summary: "Today work sync" }]
          }
        };
      }
      return { ok: false };
    })
  };
}

function makeDeps(overrides: Partial<ChatSessionManagerDeps> = {}): {
  deps: ChatSessionManagerDeps;
  engine: { submit: ReturnType<typeof vi.fn> };
} {
  const persistence: ChatPersistencePort = {
    resolveActiveProvider: vi
      .fn()
      .mockResolvedValue({ provider: "anthropic", model: "claude-3-opus" }),
    getCurrentThreadState: vi.fn().mockResolvedValue({ id: THREAD_ID, incognito: false }),
    listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
    recordTurn: vi.fn().mockResolvedValue({ userMessageId: "u1", assistantMessageId: "a1" }),
    openNewConversation: vi.fn(),
    getThreadContext: vi
      .fn()
      .mockResolvedValue({ threadTitle: null, localTimezone: "UTC", incognito: false }),
    touchExistingThread: vi.fn().mockResolvedValue(true)
  };

  const engine = {
    launch: vi.fn().mockResolvedValue({ offset: 0 }),
    submit: vi.fn().mockResolvedValue(undefined),
    readNew: vi
      .fn()
      .mockResolvedValueOnce({
        records: [{ kind: "reply", text: "Here is your plan." }],
        offset: 1,
        complete: false
      })
      .mockResolvedValue({ records: [], offset: 1, complete: true }),
    kill: vi.fn()
  };

  const deps: ChatSessionManagerDeps = {
    engineFactory: vi.fn().mockReturnValue(engine),
    persistence,
    conversationProvenance: { recordAdmission: vi.fn().mockResolvedValue(undefined) },
    personaFs: {
      writeFile: vi.fn().mockResolvedValue(undefined),
      mkdir: vi.fn().mockResolvedValue(undefined)
    },
    clock: { now: () => Date.now() },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "You are Jarvis.",
    pollMs: 0,
    idleWatchdogMs: 0,
    crossToolRead: makeCrossToolRead(),
    ...overrides
  };
  return { deps, engine };
}

function submittedTurnText(engine: { submit: ReturnType<typeof vi.fn> }): string {
  const call = engine.submit.mock.calls.find(
    (args: unknown[]) => typeof args[0] === "string" && args[0].includes("<cross_tool_context>")
  );
  expect(call).toBeDefined();
  return call![0] as string;
}

describe("ChatSessionManager priority reorder", () => {
  it("keeps relevance order when no priorityModel dep is configured", async () => {
    const { deps, engine } = makeDeps();
    const manager = new ChatSessionManager(deps);

    await manager.submitTurn("user1", "TestUser", "what should I work on today");

    expect(deps.conversationProvenance?.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "user1",
      THREAD_ID,
      "recall_cross_tool"
    );
    const text = submittedTurnText(engine);
    expect(text.indexOf("[calendar")).toBeGreaterThan(-1);
    expect(text.indexOf("[calendar")).toBeLessThan(text.indexOf("[tasks"));
  });

  it("reorders cross-tool context by the user's priority model (muted calendar sinks)", async () => {
    const priorityModel = {
      getModel: vi.fn().mockResolvedValue({
        version: 1,
        mode: "balanced",
        anchors: [
          {
            id: "calendar-work",
            kind: "project",
            label: "today work",
            aliases: [],
            weight: 2,
            enabled: true,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-01T00:00:00Z"
          }
        ],
        mutedSources: ["calendar"],
        updatedAt: "2026-07-01T00:00:00Z"
      })
    };
    const { deps, engine } = makeDeps({ priorityModel });
    const manager = new ChatSessionManager(deps);

    await manager.submitTurn("user1", "TestUser", "what should I work on today");

    expect(priorityModel.getModel).toHaveBeenCalledWith("user1");
    expect(deps.conversationProvenance?.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "user1",
      THREAD_ID,
      "recall_cross_tool"
    );
    const text = submittedTurnText(engine);
    expect(text.indexOf("[tasks")).toBeGreaterThan(-1);
    expect(text.indexOf("[tasks")).toBeLessThan(text.indexOf("[calendar"));
  });

  it("keeps the original order and completes the turn when getModel rejects", async () => {
    const priorityModel = { getModel: vi.fn().mockRejectedValue(new Error("boom")) };
    const { deps, engine } = makeDeps({ priorityModel });
    const manager = new ChatSessionManager(deps);

    const result = await manager.submitTurn("user1", "TestUser", "what should I work on today");

    expect(result.reply).toBe("Here is your plan.");
    expect(deps.conversationProvenance?.recordAdmission).toHaveBeenCalledExactlyOnceWith(
      "user1",
      THREAD_ID,
      "recall_cross_tool"
    );
    const text = submittedTurnText(engine);
    expect(text.indexOf("[calendar")).toBeLessThan(text.indexOf("[tasks"));
  });

  it("does not read the priority model when there is no cross-tool evidence", async () => {
    const priorityModel = {
      getModel: vi.fn().mockResolvedValue({
        version: 1,
        mode: "balanced",
        anchors: [],
        mutedSources: [],
        updatedAt: "2026-07-01T00:00:00Z"
      })
    };
    const crossToolRead = { runReadTool: vi.fn(async () => ({ ok: false })) };
    const { deps } = makeDeps({ priorityModel, crossToolRead });
    const manager = new ChatSessionManager(deps);

    await manager.submitTurn("user1", "TestUser", "what should I work on today");

    expect(priorityModel.getModel).not.toHaveBeenCalled();
    expect(deps.conversationProvenance?.recordAdmission).not.toHaveBeenCalled();
  });
});
