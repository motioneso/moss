import { describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import {
  REMINDER_MANAGE_FAILURE_MESSAGE,
  REMINDER_STORAGE_FAILURE_MESSAGE
} from "../../packages/chat/src/live/pre-model-turn.js";
import type { TranscriptRecord } from "../../packages/chat/src/live/types.js";
import {
  REMINDER_MAIN_ONLY_REPLY,
  REMINDER_MANAGE_MAIN_ONLY_REPLY
} from "../../packages/chat/src/reminders/wording.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";
import { resolveScheduledReadRequest } from "../../packages/chat/src/scheduled-reads/request.js";

// #3309: a reminder request is answered by code from the raw words before the gate or the model.

const SAVED = {
  userMessageId: "u-msg",
  assistantMessageId: "a-msg",
  reply: "Reminder set.",
  origin: { version: 1, kind: "reminder", event: "saved", reminderId: "r-1" }
} as const;

function setup(options: {
  read?: ReturnType<typeof vi.fn>;
  gateMode?: string;
  incognito?: boolean;
  pending?: ReturnType<typeof vi.fn>;
  pendingProposal?: boolean;
  matchingTarget?: boolean;
  prepareEdit?: ReturnType<typeof vi.fn>;
  record?: ReturnType<typeof vi.fn>;
  abortDuringThreadRead?: () => void;
}) {
  const engine = new FakeEngine(0, [
    { records: [{ kind: "reply", text: "model answer" }], offset: 10, complete: true }
  ]);
  Object.assign(engine, { purgeTranscripts: vi.fn().mockResolvedValue(undefined) });
  const recordReminderTurn = options.record ?? vi.fn().mockResolvedValue(SAVED);
  const gate = { mode: vi.fn().mockResolvedValue(options.gateMode ?? "on"), evaluate: vi.fn() };
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
      getCurrentThreadState: vi.fn(async (_actor, surface) => ({
        id: surface && surface !== "drawer" ? "side-thread" : "main-thread",
        incognito: options.incognito ?? false
      })),
      resolveScheduledReadRequest: options.read,
      hasPendingReminderDeletion: options.pending,
      recordReminderTurn,
      prepareReminderEdit: options.prepareEdit,
      hasQuietHoursReminderTarget: vi.fn().mockResolvedValue(options.matchingTarget ?? false),
      hasPendingQuietHoursProposal: vi.fn().mockResolvedValue(options.pendingProposal ?? false)
    } as never
  });
  const manager = new ChatSessionManager(deps);
  const records: TranscriptRecord[] = [];
  manager.subscribe("u1", (record) => records.push(record));
  return { manager, engine, gate, recordReminderTurn, records, getMainThreadState };
}

describe("chat reminder turn (#3309)", () => {
  it.each([
    "move the couch to the left",
    "change of plans tonight",
    "can you edit this paragraph",
    "move my reminder to 4pm"
  ])("passes %j unchanged when no pending reminder matches", async (text) => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    const { manager, engine, recordReminderTurn } = setup({ prepareEdit: prepare });
    await manager.submitTurn("u1", "Ben", text);
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
    expect(engine.submitted.join("\n")).toContain(text);
  });
  it("routes a validated edit before the normal model turn", async () => {
    const prepare = vi.fn().mockResolvedValue({ kind: "edit_refused", reply: "Nothing changed." });
    const { manager, engine, recordReminderTurn } = setup({ prepareEdit: prepare });
    await manager.submitTurn("u1", "Ben", "move my stretch reminder to 4pm");
    expect(prepare).toHaveBeenCalled();
    expect(recordReminderTurn.mock.calls[0]?.[2]).toMatchObject({ kind: "edit_refused" });
    expect(engine.launchCount).toBe(0);
  });
  it.each([
    [
      "New chat functionality! Can you remind me in 15 seconds to charge my phone?",
      15,
      "charge my phone"
    ],
    ["Remind me in 20 minutes to check the laundry task", 1200, "check the laundry task"],
    [
      "remind me in 10 minutes to check if the task is complete",
      600,
      "check if the task is complete"
    ]
  ])("keeps %s as a plain reminder", async (text, delaySeconds, reminderText) => {
    const read = vi
      .fn()
      .mockResolvedValue({ kind: "scheduled_read", taskId: null, title: "", when: null });
    const { manager, engine, recordReminderTurn } = setup({ read });
    await manager.submitTurn("u1", "Ben", text);
    expect(recordReminderTurn.mock.calls[0]?.[2]).toEqual({
      kind: "request",
      delaySeconds,
      text: reminderText
    });
    expect(read).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
  });
  it.each([
    "What's the status of the task due tomorrow?",
    "Can you check which task I should do tomorrow?"
  ])("passes the question %s unchanged in Main, private, side and meeting chat", async (text) => {
    for (const [surface, incognito] of [
      [undefined, false],
      [undefined, true],
      ["side", false],
      ["meeting", false]
    ] as const) {
      const read = vi
        .fn()
        .mockResolvedValue({ kind: "scheduled_read", taskId: null, title: "", when: null });
      const { manager, engine, recordReminderTurn } = setup({ read, incognito });
      const result = await manager.submitTurn("u1", "Ben", text, undefined, surface);
      if (!incognito) expect(result.reply).toBe("model answer");
      expect(engine.launchCount).toBe(1);
      expect(engine.submitted.join("\n")).toContain(text);
      expect(recordReminderTurn).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  });
  it.each([
    { taskId: "", timingRequest: "remind me every 60 seconds to check task" },
    { taskId: "11111111-1111-4111-8111-111111111111", timingRequest: "every 60 seconds" }
  ])("keeps a refused recurring check out of the live model: %j", async (output) => {
    const read = vi.fn(async (_actor, text, signal) =>
      resolveScheduledReadRequest(
        text,
        [{ id: "11111111-1111-4111-8111-111111111111", title: "Proof task" }],
        async () => output,
        signal
      )
    );
    const refused = {
      ...SAVED,
      reply: "I didn't set a check.",
      origin: { ...SAVED.origin, event: "refused", reminderId: null }
    };
    const record = vi.fn().mockResolvedValue(refused);
    const { manager, engine, recordReminderTurn } = setup({ read, record });
    const result = await manager.submitTurn("u1", "Ben", "Check my Proof task every 60 seconds");
    expect(result.reply).toBe(refused.reply);
    expect(recordReminderTurn.mock.calls[0]?.[2]).toMatchObject({
      kind: "scheduled_read",
      taskId: null
    });
    expect(engine.launchCount).toBe(0);
  });
  it("falls back to ordinary chat when a check has no confident owned task", async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ kind: "scheduled_read", taskId: null, title: "", when: null });
    const { manager, engine, recordReminderTurn } = setup({ read });
    await manager.submitTurn("u1", "Ben", "Check the status of my laundry task in 20 minutes");
    expect(engine.launchCount).toBe(1);
    expect(recordReminderTurn).not.toHaveBeenCalled();
  });
  it.each(["off", "shadow", "on"])(
    "keeps a marked one-time check terminal in gate mode %s",
    async (gateMode) => {
      const read = vi.fn().mockResolvedValue({
        kind: "scheduled_read",
        interpretationStarted: true,
        taskId: null,
        title: "",
        when: null
      });
      const { manager, engine, gate, recordReminderTurn } = setup({ read, gateMode });
      await manager.submitTurn("u1", "Ben", "Check the status of my laundry task in 20 minutes");
      expect(recordReminderTurn.mock.calls[0]?.[2]).toMatchObject({
        kind: "scheduled_read",
        interpretationStarted: true,
        taskId: null
      });
      expect(gate.evaluate).not.toHaveBeenCalled();
      expect(engine.launchCount).toBe(0);
    }
  );
  it("says nothing is set when a marked check cannot be stored", async () => {
    const read = vi.fn().mockResolvedValue({
      kind: "scheduled_read",
      interpretationStarted: true,
      taskId: null,
      title: "",
      when: null
    });
    const record = vi.fn().mockRejectedValue(new Error("db down"));
    const { manager, engine } = setup({ read, record });
    const result = await manager.submitTurn(
      "u1",
      "Ben",
      "Check the status of my laundry task in 20 minutes"
    );
    expect(result.reply).toBe(REMINDER_STORAGE_FAILURE_MESSAGE);
    expect(engine.launchCount).toBe(0);
  });
  it("cancels a marked check when the user stops it during a failing save", async () => {
    const holder: { manager?: ChatSessionManager } = {};
    const read = vi.fn().mockResolvedValue({
      kind: "scheduled_read",
      interpretationStarted: true,
      taskId: null,
      title: "",
      when: null
    });
    const record = vi.fn(async () => {
      await holder.manager?.stopTurn("u1");
      return undefined;
    });
    const ctx = setup({ read, record });
    holder.manager = ctx.manager;
    const result = await ctx.manager.submitTurn(
      "u1",
      "Ben",
      "Check the status of my laundry task in 20 minutes"
    );
    expect(result.reply).toBe("");
    expect(ctx.records).toEqual([{ kind: "status", text: "Stopped by user." }]);
    expect(ctx.engine.launchCount).toBe(0);
  });
  it("keeps the storage failure reply for an unmarked check stopped during a failing save", async () => {
    const holder: { manager?: ChatSessionManager } = {};
    const read = vi.fn().mockResolvedValue({
      kind: "scheduled_read",
      failure: "unavailable",
      taskId: null,
      title: "",
      when: null
    });
    const record = vi.fn(async () => {
      await holder.manager?.stopTurn("u1");
      return undefined;
    });
    const ctx = setup({ read, record });
    holder.manager = ctx.manager;
    const result = await ctx.manager.submitTurn(
      "u1",
      "Ben",
      "Check the status of my laundry task in 20 minutes"
    );
    expect(result.reply).toBe(REMINDER_STORAGE_FAILURE_MESSAGE);
    expect(ctx.engine.launchCount).toBe(0);
  });
  it("falls back to ordinary chat for a check when no resolver is wired", async () => {
    const { manager, engine, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "Check the status of my laundry task in 20 minutes");
    expect(engine.launchCount).toBe(1);
    expect(recordReminderTurn).not.toHaveBeenCalled();
  });
  it("does not resolve a check that arrives with an attachment", async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ kind: "scheduled_read", taskId: null, title: "", when: null });
    const { manager, engine } = setup({ read });
    await manager.submitTurn("u1", "Ben", "Check the status of my laundry task in 20 minutes", {
      attachments: [
        {
          id: "file",
          fileName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          createdAt: "2026-10-12T10:00:00Z"
        }
      ]
    });
    expect(read).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
  });
  it("does not resolve a check in a private chat", async () => {
    const read = vi
      .fn()
      .mockResolvedValue({ kind: "scheduled_read", taskId: null, title: "", when: null });
    const { manager, engine, recordReminderTurn } = setup({ read, incognito: true });
    const result = await manager.submitTurn(
      "u1",
      "Ben",
      "Check the status of my laundry task in 20 minutes"
    );
    expect(read).not.toHaveBeenCalled();
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
    expect(result.reply).toBe(REMINDER_MANAGE_MAIN_ONLY_REPLY);
  });
  it.each([
    "let the dog out at night",
    "let the dough rest overnight",
    "let me sleep overnight",
    "allow notifications at night",
    "allow the bread to rise overnight",
    "the baby cannot interrupt me at night",
    "let it through quiet hours"
  ])("passes unmatched everyday wording %j untouched to the model", async (text) => {
    const { manager, engine, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", text);
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
    expect(engine.submitted.join("\n")).toContain(text);
  });
  it("passes unmatched everyday wording to the model in private chat", async () => {
    const { manager, engine, recordReminderTurn } = setup({ incognito: true });
    await manager.submitTurn("u1", "Ben", "let me sleep overnight");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
  });
  it("handles everyday wording when a live reminder matches", async () => {
    const { manager, engine, recordReminderTurn } = setup({ matchingTarget: true });
    await manager.submitTurn("u1", "Ben", "let stretch through quiet hours");
    expect(recordReminderTurn).toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
  });
  it("handles wording that explicitly names an unmatched reminder", async () => {
    const { manager, engine, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "let the stretch reminder through quiet hours");
    expect(recordReminderTurn).toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
  });
  it.each(["yes", "no"])("does not confirm an allowance with attached %s", async (text) => {
    const { manager, engine, recordReminderTurn } = setup({ pendingProposal: true });
    await manager.submitTurn("u1", "Ben", text, {
      attachments: [
        {
          id: "file",
          fileName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          createdAt: "2026-10-12T10:00:00Z"
        }
      ]
    });
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
  });
  it("leaves a bare yes to ordinary chat when there is no saved allowance proposal", async () => {
    const { manager, engine, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "yes");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(1);
  });

  it("routes an owner typed yes for a stored proposal before the model", async () => {
    const { manager, engine, recordReminderTurn } = setup({ pendingProposal: true });
    await manager.submitTurn("u1", "Ben", "yes");
    expect(recordReminderTurn.mock.calls[0]?.[2]).toEqual({ kind: "quiet_agreement", agree: true });
    expect(engine.launchCount).toBe(0);
  });

  it("refuses a module-controlled allowance turn without owner authority", async () => {
    const { manager, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "let the stretch reminder through quiet hours", {
      moduleControl: "some-module"
    });
    expect(recordReminderTurn.mock.calls[0]?.[2]).toEqual({ kind: "main_only", manage: true });
  });

  it("sends ordinary text to the gate and the model, never to the reminder store", async () => {
    const { manager, engine, gate, recordReminderTurn } = setup({});
    const result = await manager.submitTurn("u1", "Ben", "what is the weather");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(gate.evaluate).toHaveBeenCalledTimes(1);
    expect(engine.launchCount).toBe(1);
    expect(result.reply).toBe("model answer");
  });

  it("sends a question that starts with 'remind me' to the gate and the model", async () => {
    const { manager, engine, gate, recordReminderTurn } = setup({});
    const result = await manager.submitTurn("u1", "Ben", "remind me the name of that restaurant");
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
    await manager.submitTurn("u1", "Ben", "remind me on Friday at 9am to stretch");
    expect(recordReminderTurn.mock.calls[0]![2]).toEqual({
      kind: "unsupported",
      reason: "unsupported_day"
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

  it("uses creation refusal wording for repeats in private chat", async () => {
    const { manager, recordReminderTurn } = setup({ incognito: true });
    const result = await manager.submitTurn("u1", "Ben", "remind me every 60 seconds to stretch");
    expect(result.reply).toBe(REMINDER_MAIN_ONLY_REPLY);
    expect(recordReminderTurn).not.toHaveBeenCalled();
  });
  it("uses creation failure wording when a repeat cannot be stored", async () => {
    const { manager } = setup({ record: vi.fn().mockRejectedValue(new Error("db down")) });
    const result = await manager.submitTurn("u1", "Ben", "remind me every 60 seconds to stretch");
    expect(result.reply).toBe(REMINDER_STORAGE_FAILURE_MESSAGE);
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

describe("chat reminder list and cancel turn (#3310)", () => {
  it.each([
    ["list my reminders", { kind: "list" }],
    ["cancel the reminder to stretch", { kind: "cancel", target: "stretch" }],
    ["cancel my reminder", { kind: "cancel", target: null }]
  ])("answers %j from the raw words without the gate or the model", async (say, plan) => {
    const { manager, engine, gate, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", say);
    expect(recordReminderTurn.mock.calls[0]![2]).toEqual(plan);
    expect(gate.evaluate).not.toHaveBeenCalled();
    expect(engine.launchCount).toBe(0);
  });

  it("never cancels for a module-controlled turn", async () => {
    const { manager, recordReminderTurn } = setup({});
    await manager.submitTurn("u1", "Ben", "cancel the reminder to stretch", {
      moduleControl: "some-module"
    });
    expect(recordReminderTurn.mock.calls[0]![2]).toEqual({ kind: "main_only", manage: true });
  });

  it("refuses in a private chat and stores nothing", async () => {
    const { manager, recordReminderTurn } = setup({ incognito: true });
    const result = await manager.submitTurn("u1", "Ben", "cancel the reminder to stretch");
    expect(recordReminderTurn).not.toHaveBeenCalled();
    expect(result.reply).toBe(REMINDER_MANAGE_MAIN_ONLY_REPLY);
  });

  it("says nothing changed when the store fails", async () => {
    const { manager, engine } = setup({ record: vi.fn().mockRejectedValue(new Error("db down")) });
    const result = await manager.submitTurn("u1", "Ben", "list my reminders");
    expect(result.reply).toBe(REMINDER_MANAGE_FAILURE_MESSAGE);
    expect(engine.launchCount).toBe(0);
  });
});

describe("reminder deletion answers before the model", () => {
  it.each(["what is the weather", "maybe later", "yes please tell me about tomorrow"])(
    "ordinary text %s reaches the model without pending-question reads",
    async (text) => {
      const pending = vi.fn().mockRejectedValue(new Error("offline"));
      const { manager, engine, recordReminderTurn } = setup({ pending });
      expect((await manager.submitTurn("u1", "Ben", text)).reply).toBe("model answer");
      expect(engine.launchCount).toBe(1);
      expect(pending).not.toHaveBeenCalled();
      expect(recordReminderTurn).not.toHaveBeenCalled();
    }
  );
  it("an attachment reaches the model while a deletion question is open", async () => {
    const pending = vi.fn().mockResolvedValue(true);
    const { manager, engine, recordReminderTurn } = setup({ pending });
    await manager.submitTurn("u1", "Ben", "yes", {
      attachments: [
        {
          id: "file",
          fileName: "note.txt",
          mimeType: "text/plain",
          sizeBytes: 1,
          createdAt: "2026-10-12T10:00:00Z"
        }
      ]
    });
    expect(engine.launchCount).toBe(1);
    expect(pending).not.toHaveBeenCalled();
    expect(recordReminderTurn).not.toHaveBeenCalled();
  });
  it.each(["yes", "no", "yeah", "yep", "sure", "ok", "nope", "keep it"])(
    "%s checks the pending question once and reuses its thread lookup",
    async (text) => {
      const pending = vi.fn().mockResolvedValue(true);
      const { manager, engine, getMainThreadState } = setup({ pending });
      await manager.submitTurn("u1", "Ben", text);
      expect(engine.launchCount).toBe(0);
      expect(pending).toHaveBeenCalledTimes(1);
      expect(getMainThreadState).toHaveBeenCalledTimes(1);
    }
  );
  it.each(["yes", "no"])("%s never reaches the model after lookup failure", async (text) => {
    const pending = vi.fn().mockRejectedValue(new Error("offline"));
    const { manager, engine, recordReminderTurn } = setup({ pending });
    expect((await manager.submitTurn("u1", "Ben", text)).reply).toBe(
      "I could not check that just now. Nothing changed, ask again."
    );
    expect(engine.launchCount).toBe(0);
    expect(recordReminderTurn).not.toHaveBeenCalled();
  });
});

it.each(["yes", "no"])(
  "%s without a pending deletion reuses the thread read on its model fallback",
  async (text) => {
    const baseline = setup({});
    const pending = vi.fn().mockResolvedValue(false);
    const candidate = setup({ pending });
    expect((await baseline.manager.submitTurn("u1", "Ben", text)).reply).toBe("model answer");
    expect((await candidate.manager.submitTurn("u1", "Ben", text)).reply).toBe("model answer");
    expect(candidate.getMainThreadState.mock.calls).toHaveLength(
      baseline.getMainThreadState.mock.calls.length
    );
    expect(pending).toHaveBeenCalledTimes(1);
  }
);
