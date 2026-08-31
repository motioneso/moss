/**
 * Unit tests for ChatSessionManager — the per-user live-session orchestrator.
 *
 * No real tmux/DB/fs: every side-effect (engine, persistence, persona fs, clock)
 * is injected as an in-memory fake. The manager is asserted purely against the
 * behaviour it drives across those seams.
 */
import { describe, expect, it } from "vitest";

import type { ProviderKind } from "../../packages/ai/src/index.js";
import {
  ChatSessionManager,
  ChatTurnInFlightError,
  type ChatPersistencePort,
  type ChatSessionManagerDeps,
  type Clock
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { PersonaFs } from "../../packages/chat/src/live/persona.js";
import {
  createRealEngineFactory,
  unavailableEngineFactory,
  CliChatUnavailableError
} from "../../packages/chat/src/live/runtime.js";
import { renderCurrentTimeContext } from "../../packages/chat/src/live/time-context.js";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";

// Fixed "now" for every manager in this file — getThreadContext here always resolves
// localTimezone: null, so every submitted turn carries this same UTC-only time block (#1869).
const NOW = new Date("2026-08-30T12:00:00.000Z");
function withTime(text: string): string {
  return `${renderCurrentTimeContext(NOW, null)}\n\n${text}`;
}

// ─── fakes ───────────────────────────────────────────────────────────────────

/**
 * Fake engine: records launch opts + submitted text, and serves a single
 * scripted reply on the first readNew after each submit.
 */
class FakeEngine implements CliChatEngine {
  launchCount = 0;
  killed = false;
  readonly launchOpts: EngineLaunchOpts[] = [];
  readonly submitted: string[] = [];

  /** Pending reply records to drain on the next readNew (set on submit). */
  private pending: TranscriptRecord[] = [];
  private alive = true;

  constructor(
    public readonly provider: ProviderKind,
    public readonly sessionKey: string,
    private readonly replyFor: (text: string) => string
  ) {}

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchCount += 1;
    this.launchOpts.push(opts);
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.submitted.push(text);
    this.pending = [
      { kind: "thinking", text: "considering" },
      { kind: "reply", text: this.replyFor(text) }
    ];
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.pending.length === 0) {
      return { records: [], offset: afterOffset, complete: false };
    }
    const records = this.pending;
    this.pending = [];
    return { records, offset: afterOffset + 1, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return this.alive;
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.alive = false;
  }
  async interrupt(): Promise<void> {}
}

/** An engine that completes after `pollsBeforeReply` readNew calls. */
class SlowEngine implements CliChatEngine {
  killed = false;
  private polls = 0;
  constructor(
    public readonly provider: ProviderKind,
    public readonly sessionKey: string,
    private readonly pollsBeforeReply = 50
  ) {}
  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(): Promise<void> {}
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (++this.polls >= this.pollsBeforeReply) {
      return {
        records: [{ kind: "reply", text: "slow reply" }],
        offset: afterOffset + 100,
        complete: true
      };
    }
    return { records: [], offset: afterOffset, complete: false };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
}

/**
 * Fake engine whose readNew blocks until an externally-controlled gate is
 * released — lets a test hold one submitTurn "in flight" while it starts a
 * second concurrent submitTurn for the same user.
 */
class GatedEngine implements CliChatEngine {
  killed = false;
  readonly submitted: string[] = [];
  private gate: Promise<void>;
  private release!: () => void;

  constructor(
    public readonly provider: ProviderKind,
    public readonly sessionKey: string
  ) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  /** Release the gate so the in-flight readNew can complete the turn. */
  open(): void {
    this.release();
  }

  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }
  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    await this.gate;
    return {
      records: [{ kind: "reply", text: "reply to: " + this.submitted.at(-1) }],
      offset: afterOffset + 1,
      complete: true
    };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
}

/**
 * Fake engine that models the REAL transcript semantics the clear() bug lived in:
 * a single append-only transcript "file" (pinned by --session-id), plus an async
 * write — the reply for a submitted turn only becomes visible on the readNew poll
 * AFTER submit (mirroring the CLI writing the record between polls). readNew returns
 * everything after `afterOffset` and reports complete iff a reply exists in that
 * slice (mirroring parseTranscript returning the LAST reply). Because clear() now
 * drops the engine and the next turn relaunches a fresh one, a post-clear turn sees
 * only its own output — the regression test below asserts exactly that.
 */
class TranscriptFakeEngine implements CliChatEngine {
  killed = false;
  readonly submitted: string[] = [];
  /** The committed transcript "file" — index position is the byte offset analogue. */
  private readonly transcript: TranscriptRecord[] = [];
  /** Reply staged by submit(), committed on the NEXT readNew (async write delay). */
  private staged: TranscriptRecord | null = null;

  constructor(
    public readonly provider: ProviderKind,
    public readonly sessionKey: string,
    private readonly replyFor: (text: string) => string
  ) {}

  async launch(): Promise<{ offset: number }> {
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.submitted.push(text);
    this.staged = { kind: "reply", text: this.replyFor(text) };
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    const slice = this.transcript.slice(afterOffset);
    const complete = slice.some((r) => r.kind === "reply");
    const result = { records: slice, offset: this.transcript.length, complete };
    // Commit the staged reply so it appears on the NEXT poll (async-write model).
    if (this.staged) {
      this.transcript.push(this.staged);
      this.staged = null;
    }
    return result;
  }

  async isAlive(): Promise<boolean> {
    return !this.killed;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {}
}

class FakePersistence implements ChatPersistencePort {
  active: { provider: ProviderKind; model: string } = {
    provider: "anthropic",
    model: "claude-x"
  };
  turns: { role: "user" | "assistant"; content: string }[] = [];
  readonly recorded: {
    userText: string;
    assistantReply: string;
    executed: { provider: ProviderKind; model: string };
    actionResults?: Parameters<ChatPersistencePort["recordTurn"]>[4] extends
      | { readonly actionResults?: infer T }
      | undefined
      ? T
      : never;
  }[] = [];
  newConversations = 0;

  async resolveActiveProvider(): Promise<{ provider: ProviderKind; model: string }> {
    return this.active;
  }

  async listPriorTurns(): Promise<{
    recent: readonly { role: "user" | "assistant"; content: string }[];
    oldSummary: string | null;
  }> {
    return { recent: [...this.turns], oldSummary: null };
  }

  async recordTurn(
    _actorUserId: string,
    userText: string,
    assistantReply: string,
    executed: { provider: ProviderKind; model: string },
    opts?: Parameters<ChatPersistencePort["recordTurn"]>[4]
  ): Promise<{ readonly userMessageId: string; readonly assistantMessageId: string }> {
    this.recorded.push({
      userText,
      assistantReply,
      executed,
      ...(opts?.actionResults?.length ? { actionResults: opts.actionResults } : {})
    });
    this.turns.push({ role: "user", content: userText });
    this.turns.push({ role: "assistant", content: assistantReply });
    return { userMessageId: "user-message-id", assistantMessageId: "assistant-message-id" };
  }

  async openNewConversation(): Promise<void> {
    this.newConversations += 1;
    this.turns = [];
  }

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

class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

const noopPersonaFs: PersonaFs = {
  async mkdir() {},
  async writeFile() {}
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── harness ─────────────────────────────────────────────────────────────────

interface Harness {
  manager: ChatSessionManager;
  persistence: FakePersistence;
  clock: FakeClock;
  engines: FakeEngine[];
}

function makeManager(over: Partial<ChatSessionManagerDeps> = {}): Harness {
  const persistence = new FakePersistence();
  const clock = new FakeClock();
  const engines: FakeEngine[] = [];

  const deps: ChatSessionManagerDeps = {
    engineFactory: (provider, sessionKey) => {
      const e = new FakeEngine(provider, sessionKey, (text) => `reply to: ${text}`);
      engines.push(e);
      return e;
    },
    persistence,
    personaFs: noopPersonaFs,
    clock,
    idleMs: 1_000,
    neutralBase: "/tmp/jarvis-test",
    persona: "I am Jarvis, {{userName}}.",
    pollMs: 0,
    now: () => NOW,
    ...over
  };

  return { manager: new ChatSessionManager(deps), persistence, clock, engines };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("ChatSessionManager", () => {
  it("launches exactly once per user and reuses the engine on a second turn", async () => {
    const { manager, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "hello");
    await manager.submitTurn("user-1", "Ben", "again");

    expect(engines).toHaveLength(1);
    expect(engines[0]?.launchCount).toBe(1);
    expect(engines[0]?.submitted).toEqual([withTime("hello"), withTime("again")]);
  });

  it("renders the user-specific persona when launching the chat context file", async () => {
    const writes: Record<string, string> = {};
    const personaFs: PersonaFs = {
      async mkdir() {},
      async writeFile(path, content) {
        writes[path] = content;
      }
    };
    const { manager } = makeManager({
      persona: async (_actorUserId, userName) =>
        `Base instructions.\n\nYour name is Friday.\n\nKeep ${userName} focused.`,
      personaFs
    });

    await manager.submitTurn("user-1", "Ben", "hello");

    expect(writes["/tmp/jarvis-test/user-1:drawer/CLAUDE.md"]).toBe(
      "Base instructions.\n\nYour name is Friday.\n\nKeep Ben focused."
    );
  });

  // #1259 — the exact reported bug as a test: neutral dir and persona were keyed by actorUserId
  // alone, so a drawer launch followed by a module-surface launch for the same user clobbered the
  // drawer's context file with the module's (no-app-map) persona. Session-keying by (actor,
  // surface) means each surface gets its own file; this asserts the drawer's file is untouched by
  // the later module launch, not merely that both files happen to exist.
  it("keeps the drawer's app-map persona intact after a later module-surface launch for the same user (#1259)", async () => {
    const writes: Record<string, string> = {};
    const personaFs: PersonaFs = {
      async mkdir() {},
      async writeFile(path, content) {
        writes[path] = content;
      }
    };
    const { manager } = makeManager({
      persona: async (_actorUserId, _userName, surface) =>
        surface === "drawer"
          ? "Base instructions.\n\nBefore answering, call app.getMapSlice."
          : "Base instructions.",
      personaFs
    });

    await manager.submitTurn("user-1", "Ben", "hello from the drawer", undefined, "drawer");
    const drawerPersonaAfterFirstLaunch = writes["/tmp/jarvis-test/user-1:drawer/CLAUDE.md"];
    expect(drawerPersonaAfterFirstLaunch).toContain("app.getMapSlice");

    await manager.submitTurn("user-1", "Ben", "hello from job search", undefined, "job-search");

    // Fails against today's clobber: the drawer file would be missing (overwritten at the same
    // path) or would have lost its app-map marker.
    expect(writes["/tmp/jarvis-test/user-1:drawer/CLAUDE.md"]).toBe(drawerPersonaAfterFirstLaunch);
    expect(writes["/tmp/jarvis-test/user-1:drawer/CLAUDE.md"]).toContain("app.getMapSlice");
    expect(writes["/tmp/jarvis-test/user-1:job-search/CLAUDE.md"]).not.toContain("app.getMapSlice");
    expect(Object.keys(writes)).toHaveLength(2);
  });

  it("emits records to subscribers, returns the reply, and persists the turn", async () => {
    const { manager, persistence } = makeManager();

    const seen: TranscriptRecord[] = [];
    const unsubscribe = manager.subscribe("user-1", (r) => seen.push(r));

    const { reply } = await manager.submitTurn("user-1", "Ben", "hello");
    unsubscribe();

    expect(reply).toBe(`reply to: ${withTime("hello")}`);
    // user echo + thinking + reply all fanned out
    expect(seen).toContainEqual({ kind: "user", text: "hello" });
    expect(seen).toContainEqual({ kind: "thinking", text: "considering" });
    expect(seen).toContainEqual({ kind: "reply", text: `reply to: ${withTime("hello")}` });

    expect(persistence.recorded).toHaveLength(1);
    expect(persistence.recorded[0]).toEqual({
      userText: "hello",
      assistantReply: `reply to: ${withTime("hello")}`,
      executed: { provider: "anthropic", model: "claude-x" }
    });
  });

  it("persists only capped terminal action outcomes from the live turn", async () => {
    const engine = new GatedEngine("anthropic", "user-1");
    const { manager, persistence } = makeManager({ engineFactory: () => engine });
    const turn = manager.submitTurn("user-1", "Ben", "enable LinkedIn");
    while (engine.submitted.length === 0) await Promise.resolve();

    for (let index = 0; index < 22; index += 1) {
      manager.injectRecord("user-1", {
        kind: "action_result",
        text: `LinkedIn monitoring enabled ${"x".repeat(220)}`,
        toolName: `job-search.portal.set-enabled.${"y".repeat(140)}`,
        outcome: "executed",
        result: { privateStructuredResult: "live only" }
      });
    }
    engine.open();
    await turn;

    expect(persistence.recorded[0]?.actionResults).toHaveLength(20);
    expect(persistence.recorded[0]?.actionResults?.[0]).toEqual({
      kind: "action_result",
      text: `LinkedIn monitoring enabled ${"x".repeat(172)}`,
      toolName: `job-search.portal.set-enabled.${"y".repeat(90)}`,
      outcome: "executed"
    });
    expect(persistence.recorded[0]?.actionResults?.[0]).not.toHaveProperty("result");
  });

  it("sends module control only to the engine and persists the clean user turn (#1194)", async () => {
    const { manager, persistence, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "Remote is right.", {
      moduleControl: '<module_control>\n{"step":"workmode"}\n</module_control>'
    });

    expect(engines[0]?.submitted.at(-1)).toBe(
      `${withTime("Remote is right.")}\n\n<module_control>\n{"step":"workmode"}\n</module_control>`
    );
    expect(persistence.recorded[0]?.userText).toBe("Remote is right.");
    expect(persistence.recorded[0]?.userText).not.toContain("module_control");
  });

  it("fans out records to multiple subscribers (multi-tab)", async () => {
    const { manager } = makeManager();
    const a: TranscriptRecord[] = [];
    const b: TranscriptRecord[] = [];
    manager.subscribe("user-1", (r) => a.push(r));
    manager.subscribe("user-1", (r) => b.push(r));

    await manager.submitTurn("user-1", "Ben", "hello");

    expect(a).toContainEqual({ kind: "reply", text: `reply to: ${withTime("hello")}` });
    expect(b).toContainEqual({ kind: "reply", text: `reply to: ${withTime("hello")}` });
  });

  it("caps simultaneous subscribers per actor", () => {
    const { manager } = makeManager();
    const unsubs = Array.from({ length: 5 }, () => manager.subscribe("user-1", () => {}));

    expect(() => manager.subscribe("user-1", () => {})).toThrow("Too many open chat streams");

    for (const unsubscribe of unsubs) unsubscribe();
  });

  it("allows another subscriber after unsubscribe frees a slot", () => {
    const { manager } = makeManager();
    const unsubs = Array.from({ length: 5 }, () => manager.subscribe("user-1", () => {}));

    unsubs.pop()?.();
    const unsubscribe = manager.subscribe("user-1", () => {});

    expect(unsubscribe).toBeTypeOf("function");
    unsubscribe();
    for (const remaining of unsubs) remaining();
  });

  it("reaps idle sessions; the next turn respawns a NEW engine and replays prior turns", async () => {
    const { manager, persistence, clock, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "hello");
    expect(engines).toHaveLength(1);
    expect(persistence.turns).toHaveLength(2); // user + assistant

    clock.advance(2_000); // past idleMs
    await manager.reapIdle();
    expect(engines[0]?.killed).toBe(true);

    await manager.submitTurn("user-1", "Ben", "second question");

    // A brand-new engine was created.
    expect(engines).toHaveLength(2);
    expect(engines[1]?.launchCount).toBe(1);

    // The new engine was seeded with prior-turn content before the new prompt.
    const seed = engines[1]?.submitted[0] ?? "";
    expect(seed).toContain("hello");
    expect(seed).toContain(`reply to: ${withTime("hello")}`);
    // ...and the actual new prompt followed the replay.
    expect(engines[1]?.submitted).toContain(withTime("second question"));
  });

  it("switchProvider kills the old engine, launches one for the new provider, and replays prior turns", async () => {
    const { manager, persistence, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "hello");
    expect(engines[0]?.provider).toBe("anthropic");

    // Operator switched their active chat provider.
    persistence.active = { provider: "google", model: "gemini-y" };
    await manager.switchProvider("user-1", "Ben");

    expect(engines[0]?.killed).toBe(true);
    expect(engines).toHaveLength(2);
    expect(engines[1]?.provider).toBe("google");

    // Prior turns replayed into the new provider's engine.
    const seed = engines[1]?.submitted[0] ?? "";
    expect(seed).toContain("hello");
    expect(seed).toContain(`reply to: ${withTime("hello")}`);

    // Next turn persists under the NEW provider/model.
    await manager.submitTurn("user-1", "Ben", "still you?");
    const last = persistence.recorded.at(-1);
    expect(last?.executed).toEqual({ provider: "google", model: "gemini-y" });
  });

  it("clear() drops the live engine and opens a new conversation; next turn relaunches fresh", async () => {
    const { manager, persistence, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "hello");
    await manager.clear("user-1");

    // The engine is killed (not reused via CLI /clear, which rotates the
    // transcript file the engine can't follow) and a new conversation is opened.
    expect(engines[0]?.killed).toBe(true);
    expect(persistence.newConversations).toBe(1);
    expect(persistence.turns).toHaveLength(0);

    // The next turn lazily relaunches a brand-new engine with no replayed context.
    await manager.submitTurn("user-1", "Ben", "fresh start");
    expect(engines).toHaveLength(2);
    expect(engines[1]?.launchCount).toBe(1);
    // No prior turns existed (conversation was cleared), so the new prompt is sent
    // directly — no <conversation> replay block precedes it.
    expect(engines[1]?.submitted).toEqual([withTime("fresh start")]);
  });

  it("clear() does not replay the previous reply on the next turn", async () => {
    // Regression: clear() used to send the CLI's /clear and reset transcriptOffset
    // to 0. But /clear rotates the transcript to a new session-id file the engine
    // can't follow (its path is pinned at launch), so the next readNew re-parsed the
    // OLD file and returned the PREVIOUS reply (then the turn after timed out). The
    // fix drops the engine on clear so the next turn relaunches with a fresh, known
    // transcript — this asserts the post-clear turn reflects the NEW prompt.
    const persistence = new FakePersistence();
    const engines: TranscriptFakeEngine[] = [];
    const manager = new ChatSessionManager({
      engineFactory: (provider, sessionKey) => {
        const e = new TranscriptFakeEngine(provider, sessionKey, (text) => `reply to: ${text}`);
        engines.push(e);
        return e;
      },
      persistence,
      personaFs: noopPersonaFs,
      clock: new FakeClock(),
      idleMs: 1_000,
      neutralBase: "/tmp/jarvis-test",
      persona: "I am Jarvis, {{userName}}.",
      pollMs: 0,
      now: () => NOW
    });

    const red = await manager.submitTurn("user-1", "Ben", "say RED");
    expect(red.reply).toBe(`reply to: ${withTime("say RED")}`);
    const blue = await manager.submitTurn("user-1", "Ben", "say BLUE");
    expect(blue.reply).toBe(`reply to: ${withTime("say BLUE")}`);

    await manager.clear("user-1");

    // The turn right after /clear must reflect the NEW prompt — not replay "say BLUE".
    const green = await manager.submitTurn("user-1", "Ben", "say GREEN");
    expect(green.reply).toBe(`reply to: ${withTime("say GREEN")}`);

    // And the conversation keeps working (the post-clear turn must not desync the read).
    const yellow = await manager.submitTurn("user-1", "Ben", "say YELLOW");
    expect(yellow.reply).toBe(`reply to: ${withTime("say YELLOW")}`);
  });

  it("does not double-launch when ensureSession is called concurrently", async () => {
    const { manager, engines } = makeManager();

    await Promise.all([
      manager.ensureSession("user-1", "Ben"),
      manager.ensureSession("user-1", "Ben")
    ]);

    expect(engines).toHaveLength(1);
    expect(engines[0]?.launchCount).toBe(1);
  });

  it("keeps separate engines per user", async () => {
    const { manager, engines } = makeManager();

    await manager.submitTurn("user-1", "Ben", "hi");
    await manager.submitTurn("user-2", "Ada", "hi");

    expect(engines).toHaveLength(2);
    expect(engines[0]?.sessionKey).not.toBe(engines[1]?.sessionKey);
  });

  it("waits until the engine reports complete (no artificial timeout cutoff)", async () => {
    // Models always respond with *something* — the poll loop must wait for the
    // engine's `complete` signal rather than cutting off after a fixed budget.
    // A never-completing engine would hang forever; this test uses an engine that
    // completes after a few polls to verify the loop doesn't cut off early.
    const persistence = new FakePersistence();
    const engines: SlowEngine[] = [];
    const manager = new ChatSessionManager({
      engineFactory: (provider, sessionKey) => {
        const e = new SlowEngine(provider, sessionKey);
        engines.push(e);
        return e;
      },
      persistence,
      personaFs: noopPersonaFs,
      clock: new FakeClock(),
      idleMs: 1_000,
      neutralBase: "/tmp/jarvis-test",
      persona: "I am Jarvis, {{userName}}.",
      pollMs: 0
    });

    const seen: TranscriptRecord[] = [];
    manager.subscribe("user-1", (r) => seen.push(r));

    const { reply } = await manager.submitTurn("user-1", "Ben", "hello");

    // The engine completed after several polls; the reply was captured.
    expect(reply).toBe("slow reply");
    expect(persistence.recorded).toHaveLength(1);
    expect(persistence.recorded[0]?.assistantReply).toBe("slow reply");
    expect(seen.some((r) => r.kind === "reply" && r.text === "slow reply")).toBe(true);
  });

  it("rejects a concurrent turn for the same user (turn-at-a-time) and recovers afterwards", async () => {
    const persistence = new FakePersistence();
    const engines: GatedEngine[] = [];
    const manager = new ChatSessionManager({
      engineFactory: (provider, sessionKey) => {
        const e = new GatedEngine(provider, sessionKey);
        engines.push(e);
        return e;
      },
      persistence,
      personaFs: noopPersonaFs,
      clock: new FakeClock(),
      idleMs: 1_000,
      neutralBase: "/tmp/jarvis-test",
      persona: "I am Jarvis, {{userName}}.",
      pollMs: 0,
      now: () => NOW
    });

    // Start the first turn; its readNew blocks on the gate, so it stays in-flight.
    // The in-flight flag is set synchronously at submitTurn's start.
    const first = manager.submitTurn("user-1", "Ben", "first");

    // A second concurrent turn for the same user must be rejected.
    await expect(manager.submitTurn("user-1", "Ben", "second")).rejects.toBeInstanceOf(
      ChatTurnInFlightError
    );

    // Wait until the engine has launched, then release the gate so the first turn
    // can complete.
    while (engines.length < 1) await delay(1);
    engines[0]?.open();
    const { reply } = await first;
    expect(reply).toBe(`reply to: ${withTime("first")}`);

    // The in-flight flag is cleared in finally, so a fresh turn succeeds.
    const next = await manager.submitTurn("user-1", "Ben", "third");
    expect(next.reply).toBe(`reply to: ${withTime("third")}`);
  });

  it("allows concurrent turns for DIFFERENT users (lock is per-actor)", async () => {
    const persistence = new FakePersistence();
    const engines: GatedEngine[] = [];
    const manager = new ChatSessionManager({
      engineFactory: (provider, sessionKey) => {
        const e = new GatedEngine(provider, sessionKey);
        engines.push(e);
        return e;
      },
      persistence,
      personaFs: noopPersonaFs,
      clock: new FakeClock(),
      idleMs: 1_000,
      neutralBase: "/tmp/jarvis-test",
      persona: "I am Jarvis, {{userName}}.",
      pollMs: 0,
      now: () => NOW
    });

    const a = manager.submitTurn("user-1", "Ben", "a");
    const b = manager.submitTurn("user-2", "Ada", "b");
    // Wait until both engines have been launched (each turn reaches its blocked
    // readNew), then release both gates so each turn can complete.
    while (engines.length < 2) await delay(1);
    for (const e of engines) e.open();

    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.reply).toBe(`reply to: ${withTime("a")}`);
    expect(rb.reply).toBe(`reply to: ${withTime("b")}`);
  });
});

describe("createRealEngineFactory", () => {
  it("builds an engine using the injected multiplexer kind", () => {
    const mux = {
      kind: "herdr" as const,
      open: async () => "h",
      submit: async () => {},
      clearComposer: async () => {},
      clearComposerHard: async () => {},
      capturePane: async () => "",
      paste: async () => {},
      pressEnter: async () => {},
      isAlive: async () => true,
      kill: async () => {},
      interrupt: async () => {},
      attachCommand: () => "herdr"
    };
    const engine = createRealEngineFactory({ mux })("anthropic", "thread-1");
    expect(engine).toBeDefined();
  });
});

describe("unavailableEngineFactory", () => {
  it("throws CliChatUnavailableError when invoked", () => {
    const factory = unavailableEngineFactory("no multiplexer");
    expect(() => factory("anthropic", "t")).toThrow(CliChatUnavailableError);
  });
});
