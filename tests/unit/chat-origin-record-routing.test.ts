import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_SURFACE, normalizeChatSurface } from "@moss/shared";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { ChatPersistencePort } from "../../packages/chat/src/live/chat-session-ports.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const timedOut: TranscriptRecord = {
  kind: "action_result",
  text: "",
  actionRequestId: "action-A",
  toolName: "tasks.create",
  summary: "Create task",
  outcome: "denied",
  decidedBy: "timeout"
};

function fixture() {
  const threads = new Map([
    ["A", { id: "A", owner: "owner", surface: DEFAULT_CHAT_SURFACE, incognito: false }],
    ["B", { id: "B", owner: "owner", surface: DEFAULT_CHAT_SURFACE, incognito: false }],
    ["private", { id: "private", owner: "owner", surface: DEFAULT_CHAT_SURFACE, incognito: true }],
    ["foreign", { id: "foreign", owner: "other", surface: DEFAULT_CHAT_SURFACE, incognito: false }],
    [
      "module",
      { id: "module", owner: "owner", surface: normalizeChatSurface("workshop"), incognito: false }
    ]
  ]);
  const current = new Map<string, string>([
    ["drawer", "A"],
    ["workshop", "module"]
  ]);
  const history = new Map<string, TranscriptRecord[]>();
  const engines: CliChatEngine[] = [];
  const flushActionRecords = vi.fn(async (_sessionKey: string) => {});
  const persistence = {
    resolveActiveProvider: vi.fn(async () => ({ provider: "anthropic" as const, model: "test" })),
    listPriorTurns: vi.fn(async () => ({ recent: [], oldSummary: null })),
    openNewConversation: vi.fn(async () => {
      current.set("drawer", "B");
    }),
    getOwnedThreadState: vi.fn(async (actor: string, id: string) => {
      const thread = threads.get(id);
      return thread?.owner === actor ? thread : undefined;
    }),
    getCurrentThreadState: vi.fn(async (_actor: string, surface = DEFAULT_CHAT_SURFACE) =>
      threads.get(current.get(surface) ?? "")
    ),
    getThreadContext: vi.fn(async () => ({
      threadTitle: null,
      localTimezone: null,
      incognito: false
    })),
    touchExistingThread: vi.fn(
      async (actor: string, id: string, surface = DEFAULT_CHAT_SURFACE) => {
        const thread = threads.get(id);
        if (thread?.owner !== actor || thread.surface !== surface) return false;
        current.set(surface, id);
        return true;
      }
    ),
    persistActionRecord: vi.fn(async (actor: string, id: string, record: TranscriptRecord) => {
      const thread = threads.get(id);
      if (thread?.owner !== actor || thread.incognito) return;
      const previous = history.get(id) ?? [];
      history.set(id, [
        ...previous.filter((entry) => entry.actionRequestId !== record.actionRequestId),
        record
      ]);
    }),
    recordTurn: vi.fn<ChatPersistencePort["recordTurn"]>(
      async (_actor, _text, reply, _model, opts) => {
        if (opts?.threadId)
          history.set(opts.threadId, [
            ...(history.get(opts.threadId) ?? []),
            ...(opts.activityRecords ?? []),
            { kind: "reply", text: reply }
          ]);
        return undefined;
      }
    )
  };
  const manager = new ChatSessionManager({
    persistence,
    flushActionRecords,
    pollMs: 0,
    idleWatchdogMs: 0,
    idleMs: 60_000,
    engineFactory: () => {
      const engine: CliChatEngine = {
        provider: "anthropic",
        launch: vi.fn(async () => ({ offset: 0 })),
        submit: vi.fn(async () => {}),
        readNew: vi.fn(async () => ({
          records: [{ kind: "reply" as const, text: "New reply" }],
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
    persona: "Moss",
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    neutralBase: "/tmp/origin-record-test",
    clock: { now: () => 0 }
  });
  const seen: TranscriptRecord[] = [];
  manager.subscribe("owner", (record) => seen.push(record));
  return { manager, persistence, history, seen, threads, current, engines, flushActionRecords };
}

describe("origin-bound action delivery", () => {
  it("keeps an old A timeout out of live and saved B after an actual resume, then reloads A's outcome", async () => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    await h.manager.resumeThread("owner", "B");
    await h.manager.ensureSession("owner", "Owner");
    await h.manager.injectOriginRecord("owner", "A", timedOut);
    await h.manager.submitTurn("owner", "Owner", "Continue B");
    expect(h.seen.some((record) => record.actionRequestId === "action-A")).toBe(false);
    expect(h.history.get("B")?.some((record) => record.actionRequestId === "action-A")).toBe(false);
    expect(h.history.get("A")).toEqual([timedOut]);
    await h.manager.resumeThread("owner", "A");
    await h.manager.ensureSession("owner", "Owner");
    expect(h.persistence.listPriorTurns).toHaveBeenLastCalledWith(
      "owner",
      expect.objectContaining({ threadId: "A" }),
      "drawer"
    );
    expect(h.history.get("A")).toEqual([timedOut]);
    expect(h.current.get("drawer")).toBe("A");
  });

  it("persists a result arriving while B is saving only to its captured A origin", async () => {
    const h = fixture();
    await h.manager.resumeThread("owner", "B");
    const saving = deferred<void>();
    const original = h.persistence.recordTurn.getMockImplementation()!;
    h.persistence.recordTurn.mockImplementation(async (...args) => {
      await saving.promise;
      return original(...args);
    });
    const turn = h.manager.submitTurn("owner", "Owner", "B turn");
    await vi.waitFor(() => expect(h.persistence.recordTurn).toHaveBeenCalledOnce());
    await h.manager.injectOriginRecord("owner", "A", timedOut);
    saving.resolve();
    await turn;
    expect(h.history.get("A")).toEqual([timedOut]);
    expect(h.history.get("B")?.some((record) => record.actionRequestId === "action-A")).toBe(false);
    expect(h.seen.some((record) => record.actionRequestId === "action-A")).toBe(false);
  });

  it("drains delayed origin lookup before persisting a completed engine reply", async () => {
    const h = fixture();
    const lookup = deferred<void>();
    const delivered = (async () => {
      await lookup.promise;
      await h.manager.injectOriginRecord("owner", "A", timedOut);
    })();
    h.flushActionRecords.mockImplementation(async () => delivered);
    const turn = h.manager.submitTurn("owner", "Owner", "A turn");
    await vi.waitFor(() => expect(h.flushActionRecords).toHaveBeenCalledWith("owner:drawer"));
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
    lookup.resolve();
    await turn;
    expect(h.persistence.recordTurn).toHaveBeenCalledWith(
      "owner",
      "A turn",
      "New reply",
      expect.any(Object),
      expect.objectContaining({
        threadId: "A",
        activityRecords: expect.arrayContaining([expect.objectContaining(timedOut)])
      }),
      "drawer"
    );
  });

  it("suppresses old-session delivery during the await inside a resume", async () => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    const resumeGate = deferred<void>();
    h.persistence.touchExistingThread.mockImplementation(async () => {
      await resumeGate.promise;
      h.current.set("drawer", "B");
      return true;
    });
    const resume = h.manager.resumeThread("owner", "B");
    await h.manager.injectOriginRecord("owner", "A", timedOut);
    expect(h.seen).toEqual([]);
    expect(h.history.get("A")).toEqual([timedOut]);
    resumeGate.resolve();
    await resume;
  });

  it("uses the owned origin's surface instead of an old transport surface", async () => {
    const h = fixture();
    const workshop: TranscriptRecord[] = [];
    h.manager.subscribe("owner", (record) => workshop.push(record), "workshop");
    await h.manager.injectOriginRecord("owner", "module", timedOut, "drawer");
    expect(h.seen).toEqual([]);
    expect(workshop).toContainEqual(timedOut);
    expect(h.history.get("module")).toEqual([timedOut]);
  });

  it.each([null, undefined, "missing", "foreign"])(
    "drops unknown or unowned origin %s without saving to current",
    async (origin) => {
      const h = fixture();
      await h.manager.injectOriginRecord("owner", origin, timedOut);
      expect(h.seen).toEqual([]);
      expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
      expect(h.persistence.recordTurn).not.toHaveBeenCalled();
      expect(h.history.size).toBe(0);
    }
  );

  it("restores history only without broadcasting into the selected origin's live turn", async () => {
    const h = fixture();
    await h.manager.injectOriginRecord("owner", "A", timedOut, undefined, true);
    expect(h.history.get("A")).toEqual([timedOut]);
    expect(h.seen).toEqual([]);
    expect(h.persistence.getCurrentThreadState).not.toHaveBeenCalled();
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
  });

  it("delivers an owned private outcome live but never persists it", async () => {
    const h = fixture();
    await h.manager.resumeThread("owner", "private");
    await h.manager.injectOriginRecord("owner", "private", timedOut);
    expect(h.seen).toContainEqual(timedOut);
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
    expect(h.history.size).toBe(0);
  });

  it("drops an origin deleted during owner lookup without redirecting the event", async () => {
    const h = fixture();
    h.threads.delete("A");
    await h.manager.injectOriginRecord("owner", "A", timedOut);
    expect(h.seen).toEqual([]);
    expect(h.history.size).toBe(0);
  });
});
