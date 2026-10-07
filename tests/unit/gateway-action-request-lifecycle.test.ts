import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiAssistantActionRequestSafeRow } from "../../packages/ai/src/repository.js";
import { ConfirmationRegistry } from "../../packages/ai/src/gateway/confirmation-registry.js";
import {
  awaitActionResolution,
  emitPendingActionRequest,
  expireActionRequest,
  resolvePersistedActionRequest
} from "../../packages/ai/src/gateway/action-request-lifecycle.js";
import { ActionRequestRecovery } from "../../packages/ai/src/gateway/action-request-recovery.js";
import { reportActionRecordFailure } from "../../packages/ai/src/gateway/action-record-diagnostics.js";

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-07T12:00:00Z"));
  const row: AiAssistantActionRequestSafeRow = {
    id: "action-1",
    owner_user_id: "owner-a",
    chat_thread_id: "conversation-a",
    chat_session_id: "owner-a:drawer",
    tool_module_id: "notes",
    tool_module_name: "Notes",
    tool_name: "notes.edit",
    permission_id: "notes.edit",
    risk: "write",
    status: "pending",
    input_summary: {},
    request_id: "request-1",
    requested_at: new Date(),
    expires_at: new Date(Date.now() + 100),
    outcome_recorded_at: null,
    outcome_ignored_at: null,
    resolved_at: null,
    updated_at: new Date()
  };
  type Scope = { actor: string };
  const visible = (db: Scope, id: string) => db.actor === row.owner_user_id && id === row.id;
  const repository = {
    listAssistantActions: vi.fn(async (db: Scope) =>
      db.actor === row.owner_user_id ? [{ ...row }] : []
    ),
    listRecoverableAssistantActions: vi.fn(async (db: Scope) =>
      db.actor === row.owner_user_id &&
      ((row.status === "pending" && row.expires_at && row.expires_at.getTime() <= Date.now()) ||
        (row.status === "timed_out" &&
          !row.outcome_recorded_at &&
          !row.outcome_ignored_at &&
          row.chat_thread_id))
        ? [{ ...row }]
        : []
    ),
    nextAssistantActionExpiry: vi.fn(async (db: Scope) =>
      db.actor === row.owner_user_id &&
      row.status === "pending" &&
      row.expires_at &&
      row.expires_at.getTime() > Date.now()
        ? row.expires_at
        : null
    ),
    getAssistantAction: vi.fn(async (db: Scope, id: string) =>
      visible(db, id) ? { ...row } : undefined
    ),
    expireAssistantAction: vi.fn(async (db: Scope, id: string) => {
      if (
        !visible(db, id) ||
        row.status !== "pending" ||
        !row.expires_at ||
        new Date(row.expires_at).getTime() > Date.now()
      )
        return undefined;
      row.status = "timed_out";
      row.resolved_at = new Date();
      return { ...row };
    }),
    resolveAssistantAction: vi.fn(
      async (db: Scope, id: string, input: { status: "confirmed" | "rejected" | "cancelled" }) => {
        if (!visible(db, id) || row.status !== "pending") return undefined;
        if (
          input.status === "confirmed" &&
          row.expires_at &&
          new Date(row.expires_at).getTime() <= Date.now()
        )
          return undefined;
        row.status = input.status;
        row.resolved_at = new Date();
        return { ...row };
      }
    )
  };
  const confirmations = new ConfirmationRegistry();
  const emit = vi.fn();
  const deps = {
    repository: repository as never,
    runner: {
      withDataContext: async (
        access: { actorUserId: string },
        work: (db: Scope) => Promise<unknown>
      ) => work({ actor: access.actorUserId })
    } as never,
    confirmations,
    confirmTimeoutMs: 100,
    notifier: { emit }
  };
  const access = { actorUserId: "owner-a" };
  const start = () => {
    const pending = awaitActionResolution(deps, access, row.id, "session-1", "turn-1");
    confirmations.storePresentation("owner-a", {
      kind: "action_request",
      actionRequestId: row.id,
      toolName: row.tool_name,
      summary: "Edit note",
      outsideContentNotice: false
    });
    return pending;
  };
  return { row, repository, confirmations, deps, access, emit, start };
}

describe("durable action resolution", () => {
  it("derives live delivery proof only from the matching owned persisted request", () => {
    const h = fixture();
    const record = {
      kind: "action_request" as const,
      actionRequestId: h.row.id,
      toolName: h.row.tool_name,
      summary: "Edit note",
      outsideContentNotice: false,
      liveOrigin: { actorUserId: "forged", chatSessionId: "forged", threadId: "forged" }
    };
    emitPendingActionRequest(h.deps, "owner-a", "owner-a:drawer", h.row, record);
    expect(h.emit.mock.calls[0]?.[1].liveOrigin).toEqual({
      actorUserId: "owner-a",
      chatSessionId: "owner-a:drawer",
      threadId: "conversation-a"
    });
    for (const row of [
      { ...h.row, id: "other-action" },
      { ...h.row, owner_user_id: "owner-b" },
      { ...h.row, chat_session_id: "owner-a:other-surface" },
      { ...h.row, chat_thread_id: null }
    ]) {
      emitPendingActionRequest(h.deps, "owner-a", "owner-a:drawer", row, record);
      expect(h.emit.mock.lastCall?.[1]).not.toHaveProperty("liveOrigin");
    }
  });

  it("persists timeout before settling and keeps the captured conversation", async () => {
    const h = fixture();
    const pending = h.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("timeout");
    expect(h.row).toMatchObject({ status: "timed_out", chat_thread_id: "conversation-a" });
    expect(h.confirmations.getPresentation("owner-a", h.row.id)).toBeUndefined();
    expect((await expireActionRequest(h.deps, h.access, h.row.id)).changed).toBe(false);
  });

  it.each(["confirmed", "rejected", "cancelled"] as const)(
    "preserves a concurrent explicit %s winner",
    async (status) => {
      const h = fixture();
      const pending = h.start();
      h.row.status = status;
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toBe(status);
      expect(h.row.status).toBe(status);
    }
  );

  it("persists session cancellation and does not later relabel it as timeout", async () => {
    const h = fixture();
    h.confirmations.beginTurn("session-1", "turn-1");
    const pending = h.start();
    expect(h.confirmations.cancelSession("session-1")).toBe(1);
    expect(await pending).toBe("cancelled");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.row.status).toBe("cancelled");
    expect(h.repository.expireAssistantAction).not.toHaveBeenCalled();
  });

  it("does not expire a young peer request or reveal it to another owner", async () => {
    const h = fixture();
    expect(await resolvePersistedActionRequest(h.deps, "owner-b", h.row.id, "confirmed")).toBe(
      "not_found"
    );
    expect(h.repository.expireAssistantAction).not.toHaveBeenCalled();
    expect(await resolvePersistedActionRequest(h.deps, "owner-a", h.row.id, "confirmed")).toBe(
      "unavailable"
    );
    expect(h.row.status).toBe("pending");
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("rejects confirmation past the durable deadline even with a live waiter", async () => {
    const h = fixture();
    const pending = h.start();
    vi.setSystemTime(new Date(Date.now() + 101));
    expect(await resolvePersistedActionRequest(h.deps, "owner-a", h.row.id, "confirmed")).toBe(
      "expired"
    );
    expect(h.row.status).toBe("timed_out");
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toBe("timeout");
    h.confirmations.markDone(h.row.id);
  });

  it.each(["rejected", "cancelled"] as const)(
    "permits orphan %s without a waiter or presentation",
    async (status) => {
      const h = fixture();
      expect(await resolvePersistedActionRequest(h.deps, "owner-a", h.row.id, status)).toBe(
        "resolved"
      );
      expect(h.row.status).toBe(status);
      expect(h.emit).toHaveBeenCalledWith(
        "owner-a:drawer",
        expect.objectContaining({
          actionRequestId: h.row.id,
          originThreadId: "conversation-a",
          decidedBy: status === "rejected" ? "person" : "cancelled"
        })
      );
    }
  );
});

describe("registry persistence failure races", () => {
  it.each(["timeout", "cancelled"] as const)(
    "bounds failed %s persistence and never grants execution",
    async (outcome) => {
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const registry = new ConfirmationRegistry();
        const actionId = `failed-${outcome}`;
        const persist = vi.fn(async () => {
          throw new Error("private SQL and action input");
        });
        registry.beginTurn("session", "turn");
        const pending = registry.awaitResolution(actionId, 10, "session", "turn", persist);
        if (outcome === "cancelled") registry.cancelSession("session");
        await vi.advanceTimersByTimeAsync(3_010);
        expect(await pending).toBe(outcome);
        expect(persist).toHaveBeenCalledTimes(3);
        expect(registry.isAwaiting(actionId)).toBe(false);
        expect(registry.resolve(actionId, "confirmed")).toBe(false);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(persist).toHaveBeenCalledTimes(3);
        // A later notifier/history failure for the same record must not multiply diagnostics.
        reportActionRecordFailure(actionId);
        expect(warn.mock.calls).toEqual([
          ["action_record_delivery_failed", { actionRequestId: actionId }]
        ]);
      } finally {
        warn.mockRestore();
      }
    }
  );

  it("bounds a hung timeout write and rejects a late approval completion", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const registry = new ConfirmationRegistry();
      const persistTimeout = vi.fn(() => new Promise<"timeout">(() => {}));
      const pending = registry.awaitResolution(
        "hung-action",
        10,
        undefined,
        undefined,
        persistTimeout
      );
      let release!: () => void;
      const approval = registry.resolveAndAwaitCompletion("hung-action", "confirmed", async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return true;
      });
      await vi.advanceTimersByTimeAsync(3_010);
      expect(await pending).toBe("timeout");
      registry.markDone("hung-action");
      release();
      expect(await approval).toBe(false);
      expect(persistTimeout).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });

  it("does not strand approval completion when timeout persistence rejects", async () => {
    vi.useFakeTimers();
    const registry = new ConfirmationRegistry();
    const pending = registry.awaitResolution("action", 10, undefined, undefined, async () => {
      throw new Error("storage unavailable");
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const approval = registry.resolveAndAwaitCompletion("action", "confirmed", async () => {
      await gate;
      return true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(registry.isAwaiting("action")).toBe(true);
    release();
    expect(await pending).toBe("confirmed");
    registry.markDone("action");
    expect(await approval).toBe(true);
  });
});

describe("owner-scoped restart recovery", () => {
  it("expires a new request and rotates beyond fifty permanently failing history rows", async () => {
    const h = fixture();
    h.row.expires_at = new Date(Date.now() - 1);
    const history = Array.from({ length: 51 }, (_, index) => ({
      ...h.row,
      id: `history-${String(index).padStart(3, "0")}`,
      status: "timed_out" as const
    }));
    const list = vi.fn(async (_db: unknown, _limit: number, cursor?: string) => [
      ...(h.row.status === "pending" ? [{ ...h.row }] : []),
      ...history.filter((row) => !cursor || row.id > cursor).slice(0, 25)
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recovery = new ActionRequestRecovery({
      ...h.deps,
      repository: { ...h.repository, listRecoverableAssistantActions: list } as never,
      notifier: {
        emit: h.emit,
        flush: async () => {
          throw new Error("private write failure");
        }
      }
    });
    try {
      await recovery.recover("owner-a");
      expect(h.row.status).toBe("timed_out");
      expect(h.repository.expireAssistantAction).toHaveBeenCalledOnce();
      await recovery.recover("owner-a");
      await recovery.recover("owner-a");
      expect(list.mock.calls.map((call) => call[2])).toEqual([
        undefined,
        "history-024",
        "history-049"
      ]);
      expect(new Set(h.emit.mock.calls.map((call) => call[1].actionRequestId)).size).toBe(52);
      await recovery.recover("owner-a");
      expect(list.mock.lastCall?.[2]).toBeUndefined();
    } finally {
      recovery.dispose();
      warn.mockRestore();
    }
  });

  it("recovers conversation A at its deadline while B is active, once", async () => {
    const h = fixture();
    const recovery = new ActionRequestRecovery(h.deps);
    await recovery.recover("owner-b");
    expect(h.row.status).toBe("pending");
    await recovery.recover("owner-a");
    await vi.advanceTimersByTimeAsync(99);
    expect(h.row.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(h.row.status).toBe("timed_out");
    expect(h.emit).toHaveBeenCalledWith(
      "owner-a:drawer",
      expect.objectContaining({ originThreadId: "conversation-a", decidedBy: "timeout" })
    );
    await recovery.recover("owner-a");
    expect(h.emit).toHaveBeenCalledTimes(2);
    expect(h.emit.mock.calls[1]?.[1]).toMatchObject({
      historyOnly: true,
      originThreadId: "conversation-a"
    });
    recovery.dispose();
  });

  it("expires unknown-origin requests without adopting the current conversation", async () => {
    const h = fixture();
    h.row.chat_thread_id = null;
    vi.setSystemTime(new Date(Date.now() + 101));
    const recovery = new ActionRequestRecovery(h.deps);
    await recovery.recover("owner-a");
    expect(h.row.status).toBe("timed_out");
    expect(h.emit).not.toHaveBeenCalled();
    recovery.dispose();
  });

  it("awaits only the original session's history flush before returning", async () => {
    const h = fixture();
    h.row.status = "timed_out";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const flush = vi.fn(async () => gate);
    const recovery = new ActionRequestRecovery({ ...h.deps, notifier: { emit: h.emit, flush } });
    let finished = false;
    const pending = recovery.recover("owner-a").then(() => {
      finished = true;
    });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledWith("owner-a:drawer"));
    expect(finished).toBe(false);
    release();
    await pending;
    expect(finished).toBe(true);
    recovery.dispose();
  });

  it("stops replaying acknowledged outcomes and never reads full action history", async () => {
    const h = fixture();
    h.row.status = "timed_out";
    const recovery = new ActionRequestRecovery(h.deps);
    await recovery.recover("owner-a");
    expect(h.emit).toHaveBeenCalledOnce();
    h.row.outcome_recorded_at = new Date();
    await recovery.recover("owner-a");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.emit).toHaveBeenCalledOnce();
    expect(h.repository.listAssistantActions).not.toHaveBeenCalled();
    expect(h.repository.listRecoverableAssistantActions).toHaveBeenCalledWith(
      { actor: "owner-a" },
      50,
      undefined
    );
    expect(h.repository.listRecoverableAssistantActions).toHaveBeenCalledTimes(2);
    recovery.dispose();
  });

  it("does not replay a positively ignored timeout or pretend its history was written", async () => {
    const h = fixture();
    h.row.status = "timed_out";
    h.row.outcome_ignored_at = new Date();
    const recovery = new ActionRequestRecovery(h.deps);
    await recovery.recover("owner-a");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.row.outcome_recorded_at).toBeNull();
    expect(h.repository.listRecoverableAssistantActions).toHaveBeenCalledOnce();
    recovery.dispose();
  });

  it("logs a failed record once using identifiers only and retries the unacknowledged outcome", async () => {
    const h = fixture();
    h.row.id = "recovery-error-1";
    h.row.expires_at = new Date(Date.now() - 1);
    h.repository.expireAssistantAction.mockRejectedValue(new Error("private SQL and content"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const recovery = new ActionRequestRecovery(h.deps);
    await recovery.recover("owner-a");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(h.repository.expireAssistantAction).toHaveBeenCalledTimes(7);
    expect(warn.mock.calls).toEqual([
      ["action_record_delivery_failed", { actionRequestId: "recovery-error-1" }]
    ]);
    warn.mockRestore();
    expect(h.row.status).toBe("pending");
    expect(h.emit).not.toHaveBeenCalled();
    recovery.dispose();
  });

  it("keeps live disclosure owner-bound, cloned, and unavailable after settlement", async () => {
    const h = fixture();
    const pending = h.start();
    expect(h.confirmations.getPresentation("owner-b", h.row.id)).toBeUndefined();
    const presentation = h.confirmations.getPresentation("owner-a", h.row.id);
    expect(presentation?.summary).toBe("Edit note");
    Object.assign(presentation!, { summary: "Forged replacement" });
    expect(h.confirmations.getPresentation("owner-a", h.row.id)?.summary).toBe("Edit note");
    h.confirmations.resolve(h.row.id, "rejected");
    await pending;
    expect(h.confirmations.getPresentation("owner-a", h.row.id)).toBeUndefined();
  });
});
