import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CHAT_SURFACE, normalizeChatSurface } from "@moss/shared";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { ChatPersistencePort } from "../../packages/chat/src/live/chat-session-ports.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { actionRefreshQueryKeys } from "../../apps/web/src/chat/use-action-query-refresh.js";

afterEach(() => vi.restoreAllMocks());

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
      if (thread?.owner !== actor || thread.incognito) return false;
      const previous = history.get(id) ?? [];
      history.set(id, [
        ...previous.filter((entry) => entry.actionRequestId !== record.actionRequestId),
        record
      ]);
      return true;
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
        interrupt: vi.fn(async () => {}),
        purgeTranscripts: vi.fn(async () => {})
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
  it("delivers a trusted outcome and refresh synchronously while model and history are held", async () => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    const model = deferred<void>();
    const history = deferred<void>();
    vi.mocked(h.engines[0]!.readNew).mockImplementation(async () => {
      await model.promise;
      return { records: [{ kind: "reply", text: "Done" }], offset: 1, complete: true };
    });
    const save = h.persistence.persistActionRecord.getMockImplementation()!;
    h.persistence.persistActionRecord.mockImplementation(async (...args) => {
      await history.promise;
      return save(...args);
    });
    const turn = h.manager.submitTurn("owner", "Owner", "Create a theme");
    await vi.waitFor(() => expect(h.engines[0]!.readNew).toHaveBeenCalledOnce());
    const completed: TranscriptRecord = {
      ...timedOut,
      outcome: "executed",
      decidedBy: "person",
      toolName: "app.callAction",
      affectsQueryKeys: ["settings.themes"],
      affectsModules: ["settings"]
    };
    const delivered = h.manager.injectLiveOriginRecord("owner", "A", completed, "drawer");
    expect(delivered).toBe(true);
    expect(h.seen.filter((record) => record.kind === "action_result")).toEqual([completed]);
    expect(actionRefreshQueryKeys(completed, [])).toContainEqual(["settings", "themes"]);
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
    const saved = h.manager.injectOriginRecord("owner", "A", completed, "drawer", true);
    h.flushActionRecords.mockImplementation(async () => {
      await saved;
    });
    await vi.waitFor(() => expect(h.persistence.persistActionRecord).toHaveBeenCalledOnce());
    expect(h.history.size).toBe(0);
    model.resolve();
    await vi.waitFor(() => expect(h.flushActionRecords).toHaveBeenCalledOnce());
    expect(h.persistence.recordTurn).not.toHaveBeenCalled();
    history.resolve();
    await expect(saved).resolves.toEqual({ historyPersisted: true });
    await turn;
    expect(h.seen.filter((record) => record.kind === "action_result")).toEqual([completed]);
    expect(h.persistence.recordTurn).toHaveBeenCalledWith(
      "owner",
      "Create a theme",
      "Done",
      expect.any(Object),
      expect.objectContaining({
        threadId: "A",
        activityRecords: expect.arrayContaining([
          expect.objectContaining({ ...completed, sequence: expect.any(Number) })
        ]),
        actionResults: expect.arrayContaining([
          expect.objectContaining({ actionRequestId: "action-A", outcome: "executed" })
        ])
      }),
      "drawer"
    );
  });

  it.each([
    ["owner", "missing", "drawer"],
    ["other", "A", "drawer"],
    ["owner", "A", "workshop"],
    ["owner", "A", ""]
  ])("refuses trusted live delivery for mismatched %s/%s/%s", async (actor, origin, surface) => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    expect(h.manager.injectLiveOriginRecord(actor!, origin!, timedOut, surface!)).toBe(false);
    expect(h.seen).toEqual([]);
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
  });

  it("requires an active frozen session for trusted live delivery", () => {
    const h = fixture();
    expect(h.manager.injectLiveOriginRecord("owner", "A", timedOut, "drawer")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it.each(["B", "private"])("keeps an A outcome out of newly active %s", async (thread) => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    await h.manager.resumeThread("owner", thread);
    await h.manager.ensureSession("owner", "Owner");
    expect(h.manager.injectLiveOriginRecord("owner", "A", timedOut, "drawer")).toBe(false);
    expect(h.seen).toEqual([]);
  });

  it("refuses synchronous delivery throughout a pending conversation transition", async () => {
    const h = fixture();
    await h.manager.ensureSession("owner", "Owner");
    const gate = deferred<void>();
    h.persistence.touchExistingThread.mockImplementation(async () => {
      await gate.promise;
      h.current.set("drawer", "B");
      return true;
    });
    const transition = h.manager.resumeThread("owner", "B");
    try {
      expect(h.manager.injectLiveOriginRecord("owner", "A", timedOut, "drawer")).toBe(false);
      expect(h.seen).toEqual([]);
    } finally {
      gate.resolve();
      await transition;
    }
  });

  it("delivers an active private outcome synchronously but never acknowledges a save", async () => {
    const h = fixture();
    await h.manager.resumeThread("owner", "private");
    await h.manager.ensureSession("owner", "Owner");
    expect(h.manager.injectLiveOriginRecord("owner", "private", timedOut, "drawer")).toBe(true);
    await expect(
      h.manager.injectOriginRecord("owner", "private", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false, historyIgnored: true });
    expect(h.seen.filter((record) => record.kind === "action_result")).toEqual([timedOut]);
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
  });

  it("acknowledges only actual persistence, including an idempotent repeat", async () => {
    const h = fixture();
    await expect(
      h.manager.injectOriginRecord("owner", "A", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: true });
    await expect(
      h.manager.injectOriginRecord("owner", "A", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: true });
    h.persistence.persistActionRecord.mockResolvedValueOnce(false);
    await expect(
      h.manager.injectOriginRecord("owner", "A", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false });
    await expect(
      h.manager.injectOriginRecord("owner", "foreign", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false, historyIgnored: true });
    expect(h.seen).toEqual([]);
  });

  it("does not mark missing owner lookup capability or origin identity as terminally ignored", async () => {
    const h = fixture();
    Object.assign(h.persistence, { getOwnedThreadState: undefined });
    await expect(
      h.manager.injectOriginRecord("owner", "A", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false });
    await expect(
      h.manager.injectOriginRecord("owner", null, timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false });
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
  });

  it("marks a positively missing owned thread as ignored without claiming a save", async () => {
    const h = fixture();
    await expect(
      h.manager.injectOriginRecord("owner", "missing", timedOut, "drawer", true)
    ).resolves.toEqual({ historyPersisted: false, historyIgnored: true });
    expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
    expect(h.seen).toEqual([]);
  });

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

  it("keeps live refresh delivery when only owned-origin history persistence fails", async () => {
    const h = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.persistence.persistActionRecord.mockRejectedValueOnce(new Error("private database payload"));
    const completed: TranscriptRecord = {
      ...timedOut,
      outcome: "executed",
      decidedBy: "person",
      toolName: "app.callAction",
      affectsQueryKeys: ["settings.themes"],
      affectsModules: ["settings"]
    };
    await expect(h.manager.injectOriginRecord("owner", "A", completed)).resolves.toEqual({
      historyPersisted: false
    });
    expect(h.seen.filter((record) => record.kind === "action_result")).toEqual([completed]);
    expect(actionRefreshQueryKeys(completed, [])).toContainEqual(["settings", "themes"]);
    expect(h.history.size).toBe(0);
    expect(warn).toHaveBeenCalledExactlyOnceWith("action_record_delivery_failed", {
      actionRequestId: completed.actionRequestId,
      errorClass: "Error"
    });
  });

  it.each(["missing", "foreign"])(
    "does not use history failure handling to bypass an %s origin",
    async (id) => {
      const h = fixture();
      h.persistence.persistActionRecord.mockRejectedValue(new Error("unavailable"));
      await h.manager.injectOriginRecord("owner", id, timedOut);
      expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
      expect(h.seen).toEqual([]);
    }
  );

  it("still suppresses a wrong-current-thread result if its origin history write fails", async () => {
    const h = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await h.manager.resumeThread("owner", "B");
    h.persistence.persistActionRecord.mockRejectedValueOnce(new Error("unavailable"));
    await h.manager.injectOriginRecord("owner", "A", timedOut);
    expect(h.seen).toEqual([]);
    expect(h.history.size).toBe(0);
  });

  it("still suppresses a result during a thread transition when history persistence fails", async () => {
    const h = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const resumeGate = deferred<void>();
    h.persistence.touchExistingThread.mockImplementation(async () => {
      await resumeGate.promise;
      return true;
    });
    const resume = h.manager.resumeThread("owner", "B");
    try {
      h.persistence.persistActionRecord.mockRejectedValueOnce(new Error("unavailable"));
      await h.manager.injectOriginRecord("owner", "A", timedOut);
      expect(h.seen).toEqual([]);
    } finally {
      resumeGate.resolve();
      await resume;
    }
  });

  it("never broadcasts a failed history-only recovery", async () => {
    const h = fixture();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.persistence.persistActionRecord.mockRejectedValueOnce(new Error("unavailable"));
    await h.manager.injectOriginRecord("owner", "A", timedOut, undefined, true);
    expect(h.seen).toEqual([]);
    expect(h.persistence.getCurrentThreadState).not.toHaveBeenCalled();
  });

  it.each(["owned", "current"] as const)(
    "keeps %s thread lookup failures closed",
    async (lookup) => {
      const h = fixture();
      const read =
        lookup === "owned"
          ? h.persistence.getOwnedThreadState
          : h.persistence.getCurrentThreadState;
      read.mockRejectedValueOnce(new Error("lookup unavailable"));
      await expect(h.manager.injectOriginRecord("owner", "A", timedOut)).rejects.toThrow(
        "lookup unavailable"
      );
      expect(h.seen).toEqual([]);
      if (lookup === "owned") expect(h.persistence.persistActionRecord).not.toHaveBeenCalled();
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
