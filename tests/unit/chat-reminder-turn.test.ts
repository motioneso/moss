import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { REMINDER_STORAGE_FAILURE_MESSAGE } from "../../packages/chat/src/live/pre-model-turn.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { REMINDER_MAIN_ONLY_REPLY } from "../../packages/chat/src/reminders/wording.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

// #3309: a reminder request is answered by code from the raw words before the gate or the model.

const SAVED = {
  userMessageId: "u-msg",
  assistantMessageId: "a-msg",
  reply: "Reminder set.",
  origin: { version: 1, kind: "reminder", event: "saved", reminderId: "r-1" }
} as const;

function setup(options: {
  incognito?: boolean;
  record?: ReturnType<typeof vi.fn>;
  abortDuringThreadRead?: () => void;
}) {
  const engine = new FakeEngine(0, [
    { records: [{ kind: "reply", text: "model answer" }], offset: 10, complete: true }
  ]);
  const recordReminderTurn = options.record ?? vi.fn().mockResolvedValue(SAVED);
  const gate = { mode: vi.fn().mockResolvedValue("on"), evaluate: vi.fn() };
  gate.evaluate.mockResolvedValue({ kind: "declined" });
  const getMainThreadState = vi.fn(async () => {
    options.abortDuringThreadRead?.();
    return { id: "main-thread", incognito: options.incognito ?? false };
  });
  const deps = makeMinimalDeps({
    engineFactory: () => engine as never,
    pollMs: 0,
    classifierGate: gate as never,
    persistence: {
      resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn().mockResolvedValue(undefined),
      openNewConversation: vi.fn().mockResolvedValue(undefined),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true),
      getMainThreadState,
      recordReminderTurn
    } as never
  });
  const manager = new ChatSessionManager(deps);
  const records: TranscriptRecord[] = [];
  manager.subscribe("u1", (record) => records.push(record));
  return { manager, engine, gate, recordReminderTurn, records };
}

describe("chat reminder turn (#3309)", () => {
  it("sends ordinary text to the gate and the model, never to the reminder store", async () => {
    const { manager, engine, gate, recordReminderTurn } = setup({});
    const result = await manager.submitTurn("u1", "Ben", "what is the weather");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(gate.evaluate).toHaveBeenCalledTimes(1);
    expect(engine.launchCount).toBe(1);
    expect(result.reply).toBe("model answer");
  });

  it("saves a reminder request from the raw words without the gate or the model", async () => {
    const { manager, engine, gate, recordReminderTurn, records } = setup({});
    const result = await manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");

    expect(recordReminderTurn).toHaveBeenCalledTimes(1);
    const [actor, text, plan, opts] = recordReminderTurn.mock.calls[0]!;
    expect(actor).toBe("u1");
    expect(text).toBe("remind me in 10 minutes to stretch");
    expect(plan).toEqual({ kind: "request", delaySeconds: 600, text: "stretch" });
    expect(opts).toMatchObject({ threadId: "main-thread" });

    expect(gate.mode).not.toHaveBeenCalled();
    expect(gate.evaluate).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
    expect(engine.submitted).toEqual([]);

    expect(records).toEqual([
      { kind: "user", text: "remind me in 10 minutes to stretch" },
      { kind: "reply", text: SAVED.reply, messageId: "a-msg", origin: SAVED.origin }
    ]);
    expect(result).toEqual({
      reply: SAVED.reply,
      userMessageId: "u-msg",
      assistantMessageId: "a-msg"
    });
  });

  it("passes an unsupported request through so the store can refuse it", async () => {
    const { manager, engine, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "remind me tomorrow at 9am to stretch");
    expect(recordReminderTurn.mock.calls[0]![2]).toEqual({
      kind: "unsupported",
      reason: "needs_relative_duration"
    });
    expect(engine.launchCount).toBe(0);
  });

  it("never saves a module-controlled turn", async () => {
    const { manager, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch", {
      moduleControl: "some-module"
    });
    expect(recordReminderTurn.mock.calls[0]![2]).toEqual({ kind: "main_only" });
  });

  it("refuses in a private chat and stores nothing", async () => {
    const { manager, engine, recordReminderTurn, records } = setup({ incognito: true });
    const result = await manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
    expect(result.reply).toBe(REMINDER_MAIN_ONLY_REPLY);
    expect(result.assistantMessageId).toBeUndefined();
    expect(records.at(-1)).toMatchObject({
      kind: "reply",
      text: REMINDER_MAIN_ONLY_REPLY,
      origin: { kind: "reminder", event: "refused", reminderId: null }
    });
  });

  it.each([
    ["throws", vi.fn().mockRejectedValue(new Error("db down"))],
    ["stores nothing", vi.fn().mockResolvedValue(undefined)]
  ])(
    "says nothing is set when the store %s, and never falls back to the model",
    async (_, record) => {
      const { manager, engine, records } = setup({ record });
      const result = await manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");
      expect(result.reply).toBe(REMINDER_STORAGE_FAILURE_MESSAGE);
      expect(engine.launchCount).toBe(0);
      expect(records.at(-1)).toMatchObject({
        kind: "reply",
        text: REMINDER_STORAGE_FAILURE_MESSAGE,
        origin: { event: "refused" }
      });
    }
  );

  it("stores nothing when the user stops the turn before it saves", async () => {
    const holder: { manager?: ChatSessionManager } = {};
    const ctx = setup({ abortDuringThreadRead: () => void holder.manager?.stopTurn("u1") });
    holder.manager = ctx.manager;
    const result = await ctx.manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");
    expect(ctx.recordReminderTurn).not.toHaveBeenCalled();
    expect(ctx.engine.launchCount).toBe(0);
    expect(result.reply).toBe("");
    expect(ctx.records).toEqual([{ kind: "status", text: "Stopped by user." }]);
  });

  it("passes the stop signal to the store so a stop during the save rolls it back", async () => {
    const holder: { manager?: ChatSessionManager } = {};
    const record = vi.fn(async (_a, _t, _p, opts: { stopSignal?: AbortSignal }) => {
      await holder.manager?.stopTurn("u1");
      return opts.stopSignal?.aborted ? "stopped" : SAVED;
    });
    const ctx = setup({ record });
    holder.manager = ctx.manager;
    const result = await ctx.manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");
    expect(record).toHaveBeenCalledTimes(1);
    expect(ctx.engine.launchCount).toBe(0);
    expect(result.reply).toBe("");
    expect(ctx.records).toEqual([{ kind: "status", text: "Stopped by user." }]);
  });

  it("shows the saved reply when the save committed before a late stop", async () => {
    const holder: { manager?: ChatSessionManager } = {};
    const record = vi.fn(async () => {
      await holder.manager?.stopTurn("u1");
      return SAVED;
    });
    const ctx = setup({ record });
    holder.manager = ctx.manager;
    const result = await ctx.manager.submitTurn("u1", "Ben", "remind me in 10 minutes to stretch");
    expect(result.reply).toBe(SAVED.reply);
    expect(ctx.records.at(-1)).toMatchObject({ kind: "reply", text: SAVED.reply });
  });
});
