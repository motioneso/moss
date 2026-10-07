import { describe, expect, it, vi } from "vitest";
import type { DataContextRunner } from "@moss/db";
import { ConfirmationRegistry, type AiRepository } from "@moss/ai";
import { emitPendingActionRequest } from "../../packages/ai/src/gateway/action-request-lifecycle.js";
import {
  ChatGatewayNotifier,
  createChatGatewayNotifier
} from "../../packages/chat/src/gateway-notifier.js";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import {
  DEFAULT_CHAT_SURFACE,
  surfaceSessionKey
} from "../../packages/chat/src/live/chat-surface.js";
import type { ChatPersistencePort } from "../../packages/chat/src/live/chat-session-ports.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { actionRefreshQueryKeys } from "../../apps/web/src/chat/use-action-query-refresh.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it("delivers the real notifier's approved refresh during a running model turn before history storage", async () => {
  const model = deferred();
  const history = deferred();
  const sessionKey = surfaceSessionKey("owner");
  const seen: TranscriptRecord[] = [];
  const persist = vi.fn(async () => {
    await history.promise;
    return true;
  });
  const lookup = vi.fn(async () => {
    throw new Error("Live proof must not need a new origin lookup");
  });
  const port: ChatPersistencePort = {
    resolveActiveProvider: async () => ({ provider: "anthropic", model: "fixture" }),
    listPriorTurns: async () => ({ recent: [], oldSummary: null }),
    getCurrentThreadState: async () => ({ id: "thread-A", incognito: false }),
    getOwnedThreadState: async () => ({
      id: "thread-A",
      surface: DEFAULT_CHAT_SURFACE,
      incognito: false
    }),
    getThreadContext: async () => ({ threadTitle: null, localTimezone: null, incognito: false }),
    openNewConversation: async () => {},
    touchExistingThread: async () => true,
    persistActionRecord: persist,
    recordTurn: async () => undefined
  };
  const submit = vi.fn(async () => {});
  const engine: CliChatEngine = {
    provider: "anthropic",
    launch: async () => ({ offset: 0 }),
    submit,
    readNew: async () => {
      await model.promise;
      return {
        records: [{ kind: "reply", text: "Finished answering" }],
        offset: 1,
        complete: true
      };
    },
    interrupt: async () => {},
    kill: async () => {},
    isAlive: async () => true
  };
  const manager: ChatSessionManager = new ChatSessionManager({
    persistence: port,
    engineFactory: () => engine,
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    clock: { now: () => 0 },
    idleMs: 60_000,
    pollMs: 0,
    idleWatchdogMs: 0,
    neutralBase: "/tmp/notifier-live-proof",
    persona: "Moss",
    flushActionRecords: (key): Promise<void> => notifier.flush(key)
  });
  const notifier: ChatGatewayNotifier = new ChatGatewayNotifier(manager, lookup);
  manager.subscribe("owner", (record) => seen.push(record));
  await manager.ensureSession("owner", "Owner");
  const turn = manager.submitTurn("owner", "Owner", "Switch my theme");
  await vi.waitFor(() => expect(submit).toHaveBeenCalled());
  const record = {
    kind: "action_request" as const,
    actionRequestId: "request-A",
    toolName: "app.callAction",
    summary: "Switch your theme",
    outsideContentNotice: true
  };
  emitPendingActionRequest(
    { confirmations: new ConfirmationRegistry(), notifier },
    "owner",
    sessionKey,
    {
      id: "request-A",
      owner_user_id: "owner",
      chat_session_id: sessionKey,
      chat_thread_id: "thread-A"
    } as never,
    record
  );
  expect(seen.some((entry) => entry.kind === "action_request")).toBe(true);
  notifier.emit(sessionKey, {
    kind: "action_result",
    actionRequestId: "request-A",
    toolName: "app.callAction",
    outcome: "executed",
    decidedBy: "person",
    affectsQueryKeys: ["settings.themes"],
    affectsModules: ["settings"]
  });
  const result = seen.find((entry) => entry.kind === "action_result");
  expect(result).toMatchObject({
    outcome: "executed",
    affectsQueryKeys: ["settings.themes"],
    affectsModules: ["settings"]
  });
  expect(actionRefreshQueryKeys(result!, [])).not.toEqual([]);
  expect(seen.some((entry) => entry.kind === "reply")).toBe(false);
  expect(lookup).not.toHaveBeenCalled();
  await vi.waitFor(() => expect(persist).toHaveBeenCalledOnce());
  history.resolve();
  model.resolve();
  await turn;
  await notifier.flush();
  expect(seen.filter((entry) => entry.kind === "action_result")).toHaveLength(1);
});

describe("notification diagnostics", () => {
  it("logs a failing record once with only its request identifier", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const notifier = new ChatGatewayNotifier({} as ChatSessionManager, async () => {
        throw new Error("private body and credentials");
      });
      const record = {
        kind: "action_result" as const,
        actionRequestId: "diagnostic-notifier-one",
        toolName: "private.tool",
        outcome: "denied" as const,
        decidedBy: "timeout" as const
      };
      notifier.emit("private-actor", record);
      notifier.emit("private-actor", record);
      await notifier.flush();
      expect(warning).toHaveBeenCalledOnce();
      expect(warning).toHaveBeenCalledWith("action_record_delivery_failed", {
        actionRequestId: record.actionRequestId,
        errorClass: "Error"
      });
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(
        /private body|credentials|private-actor|private\.tool/
      );
    } finally {
      warning.mockRestore();
    }
  });
});

describe("durable outcome acknowledgement", () => {
  it("marks replay complete only after a truthful history receipt", async () => {
    let finish!: (value: { historyPersisted: boolean }) => void;
    const saved = new Promise<{ historyPersisted: boolean }>((resolve) => {
      finish = resolve;
    });
    const manager = { injectOriginRecord: vi.fn(() => saved) } as unknown as ChatSessionManager;
    const acknowledge = vi.fn(async () => {});
    const notifier = new ChatGatewayNotifier(
      manager,
      async () => ({ found: true, threadId: "thread-A" }),
      acknowledge
    );
    notifier.emit("owner", {
      kind: "action_result",
      actionRequestId: "saved-timeout",
      toolName: "tasks.create",
      outcome: "denied",
      decidedBy: "timeout",
      historyOnly: true
    });
    await vi.waitFor(() => expect(manager.injectOriginRecord).toHaveBeenCalled());
    expect(acknowledge).not.toHaveBeenCalled();
    finish({ historyPersisted: true });
    await notifier.flush();
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith("owner", "saved-timeout", "recorded");
  });

  it.each([
    [{ historyPersisted: false }, undefined],
    [{ historyPersisted: false, historyIgnored: true }, "ignored"]
  ] as const)(
    "keeps failed saves distinct from a proven ignored origin: %j",
    async (receipt, disposition) => {
      const acknowledge = vi.fn(async () => {});
      const notifier = new ChatGatewayNotifier(
        { injectOriginRecord: vi.fn(async () => receipt) } as unknown as ChatSessionManager,
        async () => ({ found: true, threadId: "thread-A" }),
        acknowledge
      );
      notifier.emit("owner", {
        kind: "action_result",
        actionRequestId: "unsaved-timeout",
        toolName: "tasks.create",
        outcome: "denied",
        decidedBy: "timeout",
        historyOnly: true
      });
      await notifier.flush();
      if (disposition)
        expect(acknowledge).toHaveBeenCalledExactlyOnceWith(
          "owner",
          "unsaved-timeout",
          disposition
        );
      else expect(acknowledge).not.toHaveBeenCalled();
    }
  );
});

it("does not cast unattended correlation tokens as request UUIDs or adopt unknown human decisions", async () => {
  const lookup = vi.fn(async () => {
    throw new Error("invalid UUID input must never reach SQL");
  });
  const scoped = vi.fn(async (_access: unknown, work: (db: unknown) => Promise<unknown>) =>
    work({})
  );
  const deliver = vi.fn(async () => ({ historyPersisted: true }));
  const notifier = createChatGatewayNotifier(
    { injectOriginRecord: deliver } as unknown as ChatSessionManager,
    { withDataContext: scoped } as unknown as DataContextRunner,
    { getAssistantAction: lookup } as unknown as AiRepository
  );
  const record = {
    kind: "action_result" as const,
    actionRequestId: "mcp_42000000-0000-4000-8000-000000000001",
    originThreadId: "origin-A",
    toolName: "notes.create",
    outcome: "executed" as const,
    decidedBy: "policy" as const
  };
  notifier.emit("owner", record);
  await notifier.flush();
  expect(deliver).toHaveBeenCalledExactlyOnceWith(
    "owner",
    "origin-A",
    expect.objectContaining({ outcome: "executed" }),
    undefined
  );
  expect(lookup).not.toHaveBeenCalled();
  expect(scoped).not.toHaveBeenCalled();
  notifier.emit("owner", {
    ...record,
    actionRequestId: "invalid-person-request",
    decidedBy: "person"
  });
  await notifier.flush();
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("bounds orphaned live proofs and routes an evicted result through its stored origin", async () => {
  const live = vi.fn(() => true);
  const saved = vi.fn(async () => ({ historyPersisted: true }));
  const lookup = vi.fn(async () => ({ found: true, threadId: "thread-A" }));
  const manager = {
    injectLiveOriginRecord: live,
    injectOriginRecord: saved
  } as unknown as ChatSessionManager;
  const notifier = new ChatGatewayNotifier(manager, lookup);
  const session = surfaceSessionKey("owner");
  for (let index = 0; index < 1001; index += 1) {
    notifier.emit(session, {
      kind: "action_request",
      actionRequestId: `bounded-${index}`,
      toolName: "app.callAction",
      summary: "Change theme",
      outsideContentNotice: false,
      liveOrigin: { actorUserId: "owner", chatSessionId: session, threadId: "thread-A" }
    });
  }
  live.mockClear();
  notifier.emit(session, {
    kind: "action_result",
    actionRequestId: "bounded-0",
    toolName: "app.callAction",
    outcome: "executed",
    decidedBy: "person"
  });
  expect(live).not.toHaveBeenCalled();
  await notifier.flush();
  expect(lookup).toHaveBeenCalledExactlyOnceWith("owner", "bounded-0", session);
  expect(saved).toHaveBeenCalledWith(
    "owner",
    "thread-A",
    expect.objectContaining({ actionRequestId: "bounded-0" }),
    DEFAULT_CHAT_SURFACE
  );
  notifier.emit(session, {
    kind: "action_result",
    actionRequestId: "bounded-1000",
    toolName: "app.callAction",
    outcome: "executed",
    decidedBy: "person",
    affectsModules: ["theme"]
  });
  expect(live).toHaveBeenCalledWith(
    "owner",
    "thread-A",
    expect.objectContaining({ affectsModules: ["theme"] }),
    DEFAULT_CHAT_SURFACE
  );
  await notifier.flush();
  expect(lookup).toHaveBeenCalledTimes(1);
});
