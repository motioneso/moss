import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { makeMinimalDeps } from "./chat-session-manager.test.js";

// #3157: once one provider session has been fed more than the app budget, the next admitted
// turn hands off to a fresh session for the same owner, conversation and provider, replaying
// the accepted summary plus uncovered turns. The handoff happens only when that retained
// context is safe to launch; otherwise the healthy session keeps going.

const THREAD = "00000000-0000-4000-8000-000000003157";
const OTHER_THREAD = "00000000-0000-4000-8000-000000009999";
// A prepared turn here is about 200 tokens and the launch about 100, so two quiet turns stay
// under this budget while one 700-token tool result pushes the session over it.
const BUDGET = "800";
const BIG_TOOL_OUTPUT = "result ".repeat(400);

class Engine {
  readonly provider = "anthropic" as const;
  launchOpts: EngineLaunchOpts | null = null;
  readonly submitted: string[] = [];
  killed = false;
  launchGate: Promise<void> = Promise.resolve();

  constructor(private readonly output: TranscriptRecord[] = []) {}

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    await this.launchGate;
    this.launchOpts = opts;
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }
  async readNew(afterOffset: number) {
    return {
      records: [...this.output, { kind: "reply", text: `reply ${this.submitted.length}` }],
      offset: afterOffset + 1,
      complete: true
    } as { records: TranscriptRecord[]; offset: number; complete: boolean };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
}

const provider = { provider: "anthropic", model: "sonnet" } as const;

function harness(
  opts: {
    engines?: Engine[];
    recent?: { role: "user" | "assistant"; content: string }[];
    oldSummary?: string | null;
    /** History the handoff measures; the first launch still sees the small default. */
    measured?: { role: "user" | "assistant"; content: string }[];
    incognito?: boolean;
  } = {}
) {
  const engines = opts.engines ?? [
    new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]),
    new Engine()
  ];
  const launched: Engine[] = [];
  let selected: { id: string; incognito: boolean } = {
    id: THREAD,
    incognito: opts.incognito ?? false
  };
  let active: { provider: "anthropic"; model: string } = provider;
  const recordTurn = vi.fn().mockResolvedValue(undefined);
  const openNewConversation = vi.fn().mockResolvedValue(undefined);
  const requestConversationSummary = vi.fn().mockResolvedValue("queued");
  const recent = opts.recent ?? [
    { role: "user", content: "Pick a colour" },
    { role: "assistant", content: "We decided on teal." }
  ];
  const oldSummary =
    opts.oldSummary === undefined ? "Decided: the launch colour is teal." : opts.oldSummary;
  const listPriorTurns = vi.fn(async (_actor: string, binding: { measureOnly?: boolean }) => ({
    recent: binding.measureOnly && opts.measured ? opts.measured : recent,
    oldSummary
  }));
  const revoked: string[] = [];
  const deps = makeMinimalDeps({
    engineFactory: vi.fn(() => {
      const engine = engines.shift();
      if (!engine) throw new Error("ran out of engines");
      launched.push(engine);
      return engine as never;
    }),
    serverOwnsDrain: true,
    pollMs: 0,
    revokeMcpToken: (key: string) => revoked.push(key),
    conversationProvenance: { recordAdmission: vi.fn().mockResolvedValue(undefined) },
    persistence: {
      resolveActiveProvider: vi.fn(async () => active),
      listPriorTurns,
      recordTurn,
      openNewConversation,
      requestConversationSummary,
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true),
      getCurrentThreadState: vi.fn(async () => selected),
      getMainThreadState: vi.fn(async () => selected)
    }
  });
  const manager = new ChatSessionManager(deps as never);
  return {
    manager,
    engines: launched,
    recordTurn,
    openNewConversation,
    requestConversationSummary,
    listPriorTurns,
    revoked,
    select: (next: { id: string; incognito: boolean }) => {
      selected = next;
    },
    setProvider: (next: { provider: "anthropic"; model: string }) => {
      active = next;
    }
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("automatic session handoff (#3157)", () => {
  it("keeps one session while the count stays under the budget", async () => {
    const h = harness();
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.submitted).toHaveLength(2);
  });

  it("hands the next turn to a fresh session that replays the accepted summary", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness();
    await h.manager.submitTurn("u1", "Ben", "first");
    const result = await h.manager.submitTurn("u1", "Ben", "what colour did we pick?");

    expect(h.engines).toHaveLength(2);
    const [old, fresh] = h.engines as [Engine, Engine];
    expect(old.killed).toBe(true);
    expect(old.submitted).toHaveLength(1);
    expect(fresh.submitted).toHaveLength(1);
    expect(fresh.submitted[0]).toContain("what colour did we pick?");
    expect(fresh.launchOpts?.replayBatch).toContain("Decided: the launch colour is teal.");
    expect(fresh.launchOpts?.replayBatch).toContain("We decided on teal.");
    expect(result.reply).toBe("reply 1");
    // Same conversation, one stored row per real turn, no new conversation.
    expect(h.recordTurn).toHaveBeenCalledTimes(2);
    expect(h.recordTurn.mock.calls[1]![4]).toMatchObject({ threadId: THREAD });
    expect(h.openNewConversation).not.toHaveBeenCalled();
    expect(h.listPriorTurns).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ threadId: THREAD }),
      expect.any(String)
    );
  });

  it("does not echo the user turn twice across the handoff", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness();
    const seen: TranscriptRecord[] = [];
    h.manager.subscribe("u1", (record) => seen.push(record));
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(seen.filter((r) => r.kind === "user").map((r) => r.text)).toEqual(["first", "second"]);
  });

  it("counts tool output, so a turn with no reported usage still triggers the handoff", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const quiet = harness({ engines: [new Engine(), new Engine()] });
    await quiet.manager.submitTurn("u1", "Ben", "first");
    await quiet.manager.submitTurn("u1", "Ben", "second");
    expect(quiet.engines).toHaveLength(1);

    const noisy = harness();
    await noisy.manager.submitTurn("u1", "Ben", "first");
    await noisy.manager.submitTurn("u1", "Ben", "second");
    expect(noisy.engines).toHaveLength(2);
  });

  it("keeps the healthy session and asks for condensing when the retained context cannot fit", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    vi.stubEnv("JARVIS_CHAT_REPLAY_TOKENS", "2000");
    const recent = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      content: `${i}:`.padEnd(400, "x")
    }));
    const h = harness({ measured: recent, oldSummary: null });
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.killed).toBe(false);
    expect(h.engines[0]!.submitted).toHaveLength(2);
    expect(h.requestConversationSummary).toHaveBeenCalledWith(
      "u1",
      { threadId: THREAD },
      expect.any(String)
    );
  });

  it("keeps the healthy session when the condense request fails", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    vi.stubEnv("JARVIS_CHAT_REPLAY_TOKENS", "2000");
    const recent = Array.from({ length: 40 }, () => ({
      role: "user" as const,
      content: "y".repeat(400)
    }));
    const h = harness({ measured: recent, oldSummary: null });
    h.requestConversationSummary.mockRejectedValue(new Error("queue down"));
    await h.manager.submitTurn("u1", "Ben", "first");
    await expect(h.manager.submitTurn("u1", "Ben", "second")).resolves.toMatchObject({
      reply: "reply 2"
    });
    expect(h.engines).toHaveLength(1);
  });

  it("never hands off a private conversation", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const engines = [
      Object.assign(new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]), {
        purgeTranscripts: vi.fn()
      }),
      new Engine()
    ];
    const h = harness({ engines, incognito: true });
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(1);
  });

  it("keeps the healthy session for its own conversation when the selection already moved", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness();
    await h.manager.submitTurn("u1", "Ben", "first");
    h.select({ id: OTHER_THREAD, incognito: false });
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(1);
    expect(h.engines[0]!.killed).toBe(false);
    expect(h.engines[0]!.submitted[1]).toContain("second");
    expect(h.recordTurn.mock.calls[1]![4]).toMatchObject({ threadId: THREAD });
    expect(h.openNewConversation).not.toHaveBeenCalled();
  });

  it("refuses the turn instead of switching conversations when the selection moves mid-handoff", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    let release!: () => void;
    const fresh = new Engine();
    fresh.launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      engines: [
        new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]),
        fresh,
        new Engine()
      ]
    });
    await h.manager.submitTurn("u1", "Ben", "first");
    const turn = h.manager.submitTurn("u1", "Ben", "second");
    await vi.waitFor(() => expect(h.engines).toHaveLength(2));
    h.select({ id: OTHER_THREAD, incognito: false });
    release();
    await expect(turn).rejects.toThrow();
    const submittedAnywhere = h.engines.flatMap((e) => e.submitted);
    expect(submittedAnywhere.filter((t) => t.includes("second"))).toHaveLength(0);
    expect(h.engines).toHaveLength(2);
    expect(fresh.killed).toBe(true);
    expect(h.recordTurn).toHaveBeenCalledTimes(1);
    expect(h.openNewConversation).not.toHaveBeenCalled();
  });

  it("refuses the turn when the provider changes during the handoff check", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness();
    await h.manager.submitTurn("u1", "Ben", "first");
    const measure = h.listPriorTurns.getMockImplementation()!;
    h.listPriorTurns.mockImplementation(async (actor, binding) => {
      if (binding.measureOnly) h.setProvider({ provider: "anthropic", model: "opus" });
      return measure(actor, binding);
    });
    await expect(h.manager.submitTurn("u1", "Ben", "second")).rejects.toThrow();
    const submittedAnywhere = h.engines.flatMap((e) => e.submitted);
    expect(submittedAnywhere.filter((t) => t.includes("second"))).toHaveLength(0);
    expect(h.recordTurn).toHaveBeenCalledTimes(1);
  });

  it("hands off only the exact session it measured, never a newer one", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness({
      engines: [
        new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]),
        new Engine(),
        new Engine()
      ]
    });
    const measured = await h.manager.ensureSession("u1", "Ben");
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(2);
    const late = await h.manager.ensureSession("u1", "Ben", { rollover: measured });
    expect(late.engine).toBe(h.engines[1]);
    expect(h.engines).toHaveLength(2);
    expect(h.engines[1]!.killed).toBe(false);
  });

  it("never hands off another owner's session", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness({ engines: [new Engine(), new Engine(), new Engine()] });
    const mine = await h.manager.ensureSession("u1", "Ben");
    const theirs = await h.manager.ensureSession("u2", "Ann");
    const result = await h.manager.ensureSession("u2", "Ann", { rollover: mine });
    expect(result).toBe(theirs);
    expect(h.engines).toHaveLength(2);
    expect(h.engines.some((e) => e.killed)).toBe(false);
  });

  it("a stopped caller releases its wait, and the shared fresh session is kept", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    let release!: () => void;
    const fresh = new Engine();
    fresh.launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      engines: [new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]), fresh]
    });
    await h.manager.submitTurn("u1", "Ben", "first");
    const turn = h.manager.submitTurn("u1", "Ben", "second");
    await vi.waitFor(() => expect(h.engines).toHaveLength(2));
    await h.manager.stopTurn("u1");
    await expect(turn).resolves.toBeDefined();
    release();
    await vi.waitFor(() => expect(fresh.launchOpts).not.toBeNull());
    expect(fresh.submitted).toHaveLength(0);
    expect(h.recordTurn).toHaveBeenCalledTimes(1);

    await h.manager.submitTurn("u1", "Ben", "third");
    expect(h.engines).toHaveLength(2);
    expect(fresh.submitted).toHaveLength(1);
    expect(fresh.submitted[0]).toContain("third");
  });

  it("a concurrent warmup shares the handoff launch instead of starting another", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    let release!: () => void;
    const fresh = new Engine();
    fresh.launchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = harness({
      engines: [new Engine([{ kind: "tool", toolName: "search", text: BIG_TOOL_OUTPUT }]), fresh]
    });
    await h.manager.submitTurn("u1", "Ben", "first");
    const turn = h.manager.submitTurn("u1", "Ben", "second");
    await vi.waitFor(() => expect(h.engines).toHaveLength(2));
    const warmup = h.manager.ensureSession("u1", "Ben");
    release();
    const [warmed] = await Promise.all([warmup, turn]);
    expect(warmed.engine).toBe(fresh);
    expect(h.engines).toHaveLength(2);
    expect(fresh.submitted).toHaveLength(1);
  });

  it("does not seed the same context twice into the fresh session", async () => {
    vi.stubEnv("JARVIS_CHAT_SESSION_BUDGET_TOKENS", BUDGET);
    const h = harness();
    await h.manager.seedContext("u1", "Ben", "You are looking at the budget page.", "page-1");
    await h.manager.submitTurn("u1", "Ben", "first");
    await h.manager.submitTurn("u1", "Ben", "second");
    expect(h.engines).toHaveLength(2);
    await h.manager.seedContext("u1", "Ben", "You are looking at the budget page.", "page-1");
    expect(h.engines[1]!.submitted).toHaveLength(1);
  });
});
