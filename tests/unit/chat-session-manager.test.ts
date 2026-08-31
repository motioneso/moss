import { describe, expect, it, vi } from "vitest";
import {
  ChatSessionManager,
  ChatTurnInFlightError
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { EngineLaunchOpts, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import {
  CliChatDeliveryUnknownError,
  CliChatUnavailableError
} from "../../packages/chat/src/live/errors.js";
import { renderCurrentTimeContext } from "../../packages/chat/src/live/time-context.js";

// #1081: exported (not just local) so tests/unit/chat-session-manager-provider-drop.test.ts
// (split out of this file — see check:file-size, 1000-line cap) can reuse the same fixture
// instead of drifting a second copy.
export function makeMinimalDeps(
  overrides: Partial<ConstructorParameters<typeof ChatSessionManager>[0]> = {}
) {
  return {
    engineFactory: vi.fn(),
    persistence: {
      resolveActiveProvider: vi.fn(),
      listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
      recordTurn: vi.fn(),
      openNewConversation: vi.fn(),
      getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
      touchExistingThread: vi.fn().mockResolvedValue(true)
    },
    personaFs: {
      mkdir: vi.fn().mockResolvedValue(undefined),
      writeFile: vi.fn().mockResolvedValue(undefined)
    },
    clock: { now: () => Date.now() },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "You are Jarvis.",
    ...overrides
  };
}

/**
 * A scriptable fake engine. `launchOffset` is what `launch` returns (§4.1.2): an in-process
 * engine returns 0 (the manager owns the drain); an RPC engine returns the post-drain offset.
 * `readNew` replays a queued script of results so a test can model the "replay drained
 * server-side, first real readNew returns the NEW reply" correctness case (§12).
 */
class FakeEngine {
  readonly provider = "anthropic" as const;
  launchOpts: EngineLaunchOpts | null = null;
  readonly submitted: string[] = [];
  interrupted = false;
  killed = false;
  launchCount = 0;
  private readonly readScript: { records: TranscriptRecord[]; offset: number; complete: boolean }[];

  constructor(
    private readonly launchOffset = 0,
    readScript: { records: TranscriptRecord[]; offset: number; complete: boolean }[] = []
  ) {
    this.readScript = readScript;
  }

  async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
    this.launchOpts = opts;
    this.launchCount += 1;
    return { offset: this.launchOffset };
  }
  async submit(text: string): Promise<void> {
    this.submitted.push(text);
  }
  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    const next = this.readScript.shift();
    if (next) return next;
    return { records: [], offset: afterOffset, complete: true };
  }
  async isAlive(): Promise<boolean> {
    return !this.killed;
  }
  async kill(): Promise<void> {
    this.killed = true;
  }
  async interrupt(): Promise<void> {
    this.interrupted = true;
  }
}

describe("ChatSessionManager.injectRecord", () => {
  it("fans out the record to all subscribers of that user", () => {
    const manager = new ChatSessionManager(makeMinimalDeps());
    const received: unknown[] = [];
    manager.subscribe("u1", (r) => received.push(r));

    manager.injectRecord("u1", {
      kind: "action_request",
      text: "Approve?",
      actionRequestId: "ar_1",
      toolName: "t",
      summary: "s"
    });

    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe("action_request");
  });

  it("does nothing when no subscribers are registered", () => {
    const manager = new ChatSessionManager(makeMinimalDeps());
    expect(() =>
      manager.injectRecord("u_nobody", { kind: "action_request", text: "x" })
    ).not.toThrow();
  });
});

describe("ChatSessionManager MCP lifecycle hooks", () => {
  it("accepts mintMcpToken in deps without throwing", () => {
    const mint = vi
      .fn()
      .mockReturnValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    expect(() => new ChatSessionManager(makeMinimalDeps({ mintMcpToken: mint }))).not.toThrow();
  });
});

describe("ChatSessionManager.launchSession — personaText + replayBatch + offset seeding (#342 §4.1)", () => {
  function depsWith(
    engine: FakeEngine,
    priorTurns = { recent: [], oldSummary: null } as {
      recent: readonly { role: "user" | "assistant"; content: string }[];
      oldSummary: string | null;
    },
    // #342 (§4.1.2): the explicit drain-ownership discriminator. Default false = in-process
    // path (manager owns submit+drain); true = RPC path (server owns it). Lane A's wiring sets
    // this true exactly when the RPC engine factory is selected (socket configured).
    serverOwnsDrain = false
  ) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      persona: "You are Jarvis.",
      serverOwnsDrain,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue(priorTurns),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    });
  }

  it("passes the rendered persona CONTENT as personaText on launch (both paths)", async () => {
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(depsWith(engine));
    await manager.ensureSession("u1", "Ben");
    expect(engine.launchOpts?.personaText).toBe("You are Jarvis.");
  });

  it("passes provider execution mode to the engine factory", async () => {
    const engine = new FakeEngine(0);
    const deps = depsWith(engine);
    vi.mocked(deps.persistence.resolveActiveProvider).mockResolvedValue({
      provider: "openai-compatible",
      model: "default",
      executionMode: "non_interactive"
    });
    const engineFactory = vi.fn(() => engine);
    const manager = new ChatSessionManager({ ...deps, engineFactory });

    await manager.ensureSession("u1", "Ben");

    expect(engineFactory).toHaveBeenCalledWith("openai-compatible", "u1:drawer", {
      executionMode: "non_interactive"
    });
  });

  it("assembles replayBatch from prior turns and ships it on launch", async () => {
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(
      depsWith(engine, {
        recent: [{ role: "user", content: "hi" }],
        oldSummary: null
      })
    );
    await manager.ensureSession("u1", "Ben");
    expect(engine.launchOpts?.replayBatch).toContain("<conversation>");
    expect(engine.launchOpts?.replayBatch).toContain("hi");
  });

  it("sends NO replayBatch for a fresh conversation", async () => {
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(depsWith(engine));
    await manager.ensureSession("u1", "Ben");
    expect(engine.launchOpts?.replayBatch).toBeUndefined();
  });

  it("in-process path (launch returns 0): manager submits + drains the replay itself", async () => {
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(
      depsWith(engine, {
        recent: [{ role: "user", content: "earlier" }],
        oldSummary: null
      })
    );
    await manager.ensureSession("u1", "Ben");
    // The manager performed its own submit of the replay (in-process drain path).
    expect(engine.submitted).toHaveLength(1);
    expect(engine.submitted[0]).toContain("earlier");
  });

  it("RPC path (serverOwnsDrain, post-drain offset > 0): manager does NOT re-submit the replay", async () => {
    // Replay was drained server-side; launch returns the post-drain offset and the explicit
    // serverOwnsDrain discriminator tells the manager the server owns the submit+drain.
    const engine = new FakeEngine(42);
    const manager = new ChatSessionManager(
      depsWith(
        engine,
        {
          recent: [{ role: "user", content: "earlier" }],
          oldSummary: null
        },
        true // serverOwnsDrain = RPC path
      )
    );
    await manager.ensureSession("u1", "Ben");
    expect(engine.submitted).toHaveLength(0); // no client-side re-submit
  });

  it("RPC path with serverOwnsDrain AND offset === 0: manager STILL does NOT re-submit (no double-submit over the socket)", async () => {
    // The LOW-correctness edge this discriminator fixes: offset === 0 is ALSO a legitimate RPC
    // result — a replay was submitted server-side but the transcript never materialized within
    // the server's drain budget. Keying the in-process re-drain on `offset === 0` would make the
    // manager DOUBLE-submit the replay over the socket. With the explicit serverOwnsDrain flag the
    // RPC path is skipped REGARDLESS of the offset value.
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(
      depsWith(
        engine,
        {
          recent: [{ role: "user", content: "earlier" }],
          oldSummary: null
        },
        true // serverOwnsDrain = RPC path, even though launch returned offset 0
      )
    );
    await manager.ensureSession("u1", "Ben");
    expect(engine.submitted).toHaveLength(0); // NO double-submit despite offset 0
  });

  it("in-process path keeps re-draining even when launch happens to return offset > 0 (discriminator, not the sentinel)", async () => {
    // Symmetric guard: serverOwnsDrain=false (in-process) must ALWAYS re-submit+drain the replay,
    // regardless of the offset the engine returns — the decision is the discriminator, never the
    // offset value.
    const engine = new FakeEngine(7);
    const manager = new ChatSessionManager(
      depsWith(
        engine,
        {
          recent: [{ role: "user", content: "earlier" }],
          oldSummary: null
        },
        false // in-process path despite a non-zero launch offset
      )
    );
    await manager.ensureSession("u1", "Ben");
    expect(engine.submitted).toHaveLength(1);
    expect(engine.submitted[0]).toContain("earlier");
  });

  it("§12 correctness: after a replay drained server-side, the first turn returns the NEW reply (not the replayed history)", async () => {
    // RPC engine drained the replay to offset 100 at launch. The first real submitTurn must
    // start readNew FROM 100, so it observes only the new reply — never the replayed history.
    const engine = new FakeEngine(100, [
      {
        records: [{ kind: "reply", text: "fresh answer" }],
        offset: 160,
        complete: true
      }
    ]);
    const now = new Date("2026-08-30T12:00:00.000Z");
    const manager = new ChatSessionManager({
      ...depsWith(
        engine,
        {
          recent: [{ role: "user", content: "old turn that was replayed" }],
          oldSummary: null
        },
        true // RPC path: the server drained the replay to offset 100 at launch
      ),
      pollMs: 0,
      now: () => now
    });

    const { reply } = await manager.submitTurn("u1", "Ben", "new question");
    expect(reply).toBe("fresh answer");
    // The engine was launched once and the replay was NOT re-submitted as a turn.
    expect(engine.launchCount).toBe(1);
    // And the server-owned drain meant NO client-side replay submit at all.
    expect(engine.submitted).toEqual([`${renderCurrentTimeContext(now, null)}\n\nnew question`]);
  });

  it("does not submit the first real turn until replay launch has resolved", async () => {
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });
    class GatedLaunchEngine extends FakeEngine {
      override async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
        this.launchOpts = opts;
        this.launchCount += 1;
        await launchGate;
        return { offset: 100 };
      }
    }
    const engine = new GatedLaunchEngine(100, [
      { records: [{ kind: "reply", text: "fresh answer" }], offset: 160, complete: true }
    ]);
    const now = new Date("2026-08-30T12:00:00.000Z");
    const manager = new ChatSessionManager({
      ...depsWith(
        engine,
        { recent: [{ role: "user", content: "replayed" }], oldSummary: null },
        true
      ),
      pollMs: 0,
      now: () => now
    });

    const turn = manager.submitTurn("u1", "Ben", "first real turn");
    await vi.waitFor(() => expect(engine.launchCount).toBe(1));
    expect(engine.submitted).toEqual([]);

    releaseLaunch();
    await expect(turn).resolves.toMatchObject({ reply: "fresh answer" });
    expect(engine.submitted).toEqual([`${renderCurrentTimeContext(now, null)}\n\nfirst real turn`]);
  });

  it("seeds hidden context by submitting and draining without recording a chat turn", async () => {
    const engine = new FakeEngine(0);
    const recordTurn = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        pollMs: 0,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await manager.seedContext(
      "u1",
      "Ben",
      "<trusted_instructions>\nEvening interview seed.\n</trusted_instructions>\n\n" +
        '<external_source type="evening_review">\nReview text\n</external_source>'
    );

    expect(engine.submitted).toHaveLength(1);
    expect(engine.submitted[0]).toContain('<external_source type="evening_review">');
    expect(recordTurn).not.toHaveBeenCalled();
  });

  it("seeds a keyed context at most once per live engine session (#1194)", async () => {
    const engine = new FakeEngine(0);
    const manager = new ChatSessionManager(depsWith(engine));

    await manager.seedContext("u1", "Ben", "seed", "module-context:demo-module");
    await manager.seedContext("u1", "Ben", "seed", "module-context:demo-module");

    expect(engine.submitted).toEqual(["seed"]);
  });
});

describe("ChatSessionManager.submitTurn turn-lock release (#445)", () => {
  // A FakeEngine whose submit() REJECTS — modelling the api-side per-RPC deadline firing on a
  // cli-runner that ACCEPTED the frame but never replied (chat-engine-rpc-client §3.4). The #445
  // bug: a hung submit/readNew left `turnsInFlight` set forever, so every later turn 409'd
  // "a chat turn is already in progress" until the api restarted. The fix's contract is that a
  // rejected engine call must flow through submitTurn's try/finally and CLEAR the per-user lock.
  class RejectingSubmitEngine extends FakeEngine {
    override async submit(): Promise<void> {
      throw new CliChatUnavailableError("cli-runner submit timed out after 45000ms");
    }
  }

  function rejectingDeps(engine: FakeEngine) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      pollMs: 0,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    });
  }

  it("clears the per-user lock when the engine call rejects, so the next turn is not a permanent 409", async () => {
    const manager = new ChatSessionManager(rejectingDeps(new RejectingSubmitEngine()));

    // Turn 1: the engine submit rejects (the timed-out RPC). submitTurn must surface that rejection.
    await expect(manager.submitTurn("u1", "Ben", "first")).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );

    // Turn 2 (same user): the lock must already be released. Under #445 this was a
    // ChatTurnInFlightError forever. It may still fail for the SAME underlying reason (the engine
    // rejects again) — but it MUST NOT be the stuck-lock 409.
    const second = await manager.submitTurn("u1", "Ben", "second").catch((e: unknown) => e);
    expect(second).not.toBeInstanceOf(ChatTurnInFlightError);
    expect(second).toBeInstanceOf(CliChatUnavailableError);
  });

  it("invalidates the live session on delivery_unknown and never auto-resends", async () => {
    class UnknownDeliveryEngine extends FakeEngine {
      override async submit(text: string): Promise<void> {
        this.submitted.push(text);
        throw new CliChatDeliveryUnknownError("chat input delivery is unknown");
      }
    }
    const first = new UnknownDeliveryEngine();
    const second = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "second reply" }], offset: 1, complete: true }
    ]);
    const engines = [first, second];
    const engineFactory = vi.fn(() => engines.shift()!);
    const revokeMcpToken = vi.fn();
    const now = new Date("2026-08-30T12:00:00.000Z");
    const manager = new ChatSessionManager({
      ...rejectingDeps(first),
      engineFactory,
      revokeMcpToken,
      pollMs: 0,
      now: () => now
    });

    await expect(manager.submitTurn("u1", "Ben", "first")).rejects.toBeInstanceOf(
      CliChatDeliveryUnknownError
    );
    await expect(manager.submitTurn("u1", "Ben", "second")).resolves.toMatchObject({
      reply: "second reply"
    });

    expect(first.submitted).toEqual([`${renderCurrentTimeContext(now, null)}\n\nfirst`]);
    expect(second.submitted).toEqual([`${renderCurrentTimeContext(now, null)}\n\nsecond`]);
    expect(engineFactory).toHaveBeenCalledTimes(2);
    expect(revokeMcpToken).toHaveBeenCalledWith("u1:drawer");
  });
});

describe("ChatSessionManager passive retrieval", () => {
  function depsForPassive(engine: FakeEngine, overrides = {}) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      pollMs: 0,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      },
      ...overrides
    });
  }

  it("submits retrieved context to the engine but records only raw user text", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "answer" }], offset: 10, complete: true }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager(
      depsForPassive(engine, {
        passiveRetrieval: {
          retrieve: vi.fn().mockResolvedValue("<retrieved_context>\n- memory\n</retrieved_context>")
        },
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await manager.submitTurn("u1", "Ben", "what did we decide?");
    expect(engine.submitted.at(-1)).toContain("<retrieved_context>");
    expect(engine.submitted.at(-1)).toContain("what did we decide?");
    expect(recordTurn).toHaveBeenCalledWith(
      "u1",
      "what did we decide?",
      "answer",
      {
        provider: "anthropic",
        model: "sonnet"
      },
      expect.objectContaining({
        invokedToolNames: expect.any(Set),
        actionResults: []
      }),
      "drawer"
    );
  });

  it("continues with raw text when passive retrieval throws", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "answer" }], offset: 10, complete: true }
    ]);
    const now = new Date("2026-08-30T12:00:00.000Z");
    const manager = new ChatSessionManager(
      depsForPassive(engine, {
        passiveRetrieval: { retrieve: vi.fn().mockRejectedValue(new Error("boom")) },
        now: () => now
      })
    );

    await manager.submitTurn("u1", "Ben", "what did we decide?");

    expect(engine.submitted.at(-1)).toBe(
      `${renderCurrentTimeContext(now, null)}\n\nwhat did we decide?`
    );
  });

  it("carries a fresh, correct local date on each turn of the same conversation without relaunching (#1869)", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "first answer" }], offset: 10, complete: true },
      { records: [{ kind: "reply", text: "second answer" }], offset: 20, complete: true }
    ]);
    let now = new Date("2026-08-30T03:30:00.000Z"); // 2026-08-29 23:30 America/New_York
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager(
      depsForPassive(engine, {
        now: () => now,
        personaFs: { mkdir: vi.fn().mockResolvedValue(undefined), writeFile },
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi
            .fn()
            .mockResolvedValue({ threadTitle: null, localTimezone: "America/New_York" }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await manager.submitTurn("u1", "Ben", "first");
    const firstNow = now;
    now = new Date("2026-08-30T05:00:00.000Z"); // 2026-08-30 01:00 America/New_York — crosses local midnight
    await manager.submitTurn("u1", "Ben", "second");

    expect(engine.submitted).toEqual([
      `${renderCurrentTimeContext(firstNow, "America/New_York")}\n\nfirst`,
      `${renderCurrentTimeContext(now, "America/New_York")}\n\nsecond`
    ]);
    expect(engine.submitted[0]).not.toBe(engine.submitted[1]);
    expect(engine.launchCount).toBe(1); // same session reused across both turns, no relaunch

    // Persona byte-stability: the persona file is written once at launch and never rewritten
    // with turn-specific content, so no date leaks into the fixed introduction text (#1869).
    expect(writeFile).toHaveBeenCalledTimes(1);
  });
});

describe("ChatSessionManager.reconcileLiveSessions (#342 §5.3)", () => {
  it("revokes orphaned tokens via the registry even when the sessions Map is empty (api restart)", async () => {
    const reconcileMcpTokens = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        reconcileMcpTokens,
        listMcpTokenSessionIds: () => ["uA", "uB"],
        killSession: vi.fn().mockResolvedValue(undefined)
      })
    );
    // sessions Map is empty; cli-runner reports only uA alive.
    await manager.reconcileLiveSessions(new Set(["uA"]));
    // Token sweep is sourced from the registry, scoped to the live set.
    expect(reconcileMcpTokens).toHaveBeenCalledWith(new Set(["uA"]));
  });

  it("kills an orphaned mux session by name for a live key the manager does not know", async () => {
    const killSession = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        reconcileMcpTokens: vi.fn(),
        // The registry still remembers uKnown (api held a token) but not uOrphan.
        listMcpTokenSessionIds: () => ["uKnown"],
        killSession
      })
    );
    // cli-runner reports uKnown + uOrphan alive; the manager knows neither in its Map.
    await manager.reconcileLiveSessions(new Set(["uKnown", "uOrphan"]));
    // uOrphan is unknown to both the Map AND the token registry → reaped by mux name.
    expect(killSession).toHaveBeenCalledWith("uOrphan");
    // uKnown is in the token-registry known set → NOT reaped.
    expect(killSession).not.toHaveBeenCalledWith("uKnown");
  });

  it("treats an in-flight launch key as live (never killed/revoked) during reconciliation", async () => {
    // A slow launch keeps uLaunching in the `launching` map across the reconcile call.
    let releaseLaunch: () => void = () => {};
    const launchGate = new Promise<void>((r) => {
      releaseLaunch = r;
    });
    const slowEngine = {
      provider: "anthropic" as const,
      launch: vi.fn().mockImplementation(async () => {
        await launchGate;
        return { offset: 0 };
      }),
      submit: vi.fn().mockResolvedValue(undefined),
      readNew: vi.fn().mockResolvedValue({ records: [], offset: 0, complete: true }),
      isAlive: vi.fn().mockResolvedValue(true),
      kill: vi.fn().mockResolvedValue(undefined),
      interrupt: vi.fn().mockResolvedValue(undefined)
    };
    const killSession = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => slowEngine,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        },
        reconcileMcpTokens: vi.fn(),
        listMcpTokenSessionIds: () => [],
        killSession
      })
    );

    const launchPromise = manager.ensureSession("uLaunching", "Ben");
    // cli-runner does NOT report uLaunching yet (its mux session is still booting), but the
    // manager must union the launching key in and NOT reap it.
    await manager.reconcileLiveSessions(new Set([]));
    expect(killSession).not.toHaveBeenCalled();

    releaseLaunch();
    await launchPromise;
  });

  it("drops a stale RPC session (+ revokes its token) and still reaps step-4 orphans when the engine kill rejects under the reconcile guard", async () => {
    // Regression for the step-3 self-misfire: on the RPC path `reconcileLiveSessions` runs INSIDE
    // the connection's `runReconciliation` with `reconciling = true`, so a `session.engine.kill()`
    // here routes through the gated public `RpcConnection.kill`, which throws
    // CliChatUnavailableError("cli-runner reconciling after restart"). Before the fix that throw
    // propagated out of step 3 BEFORE `sessions.delete` + `revokeMcpToken`, aborting the rest of
    // the loop AND step 4 (orphan reaping). Step 3 must instead route the kill through the
    // guard-bypassing `killSession` dep (and is try/catch-wrapped), so the drop + revoke + step 4
    // all still happen. We model the failure with a fake RPC engine whose own `kill()` rejects.
    const reconcilingError = new CliChatUnavailableError("cli-runner reconciling after restart");
    // A fresh fake RPC engine per launch; whose kill rejects exactly as the gated public
    // connection would mid-reconcile (so if step 3 ever calls engine.kill() it would throw and
    // — pre-fix — abort the rest of the pass).
    const engines: FakeEngine[] = [];
    const engineFactory = vi.fn(() => {
      const e = new FakeEngine(0);
      e.kill = vi.fn().mockRejectedValue(reconcilingError) as unknown as FakeEngine["kill"];
      engines.push(e);
      return e;
    });
    const revokeMcpToken = vi.fn();
    // killSession is the guard-bypassing reconcile-driver path (present on the RPC path). It is
    // what step 3 + step 4 must both use; engine.kill() must NOT be the path step 3 takes.
    const killSession = vi.fn().mockResolvedValue(undefined);
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory,
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        },
        revokeMcpToken,
        reconcileMcpTokens: vi.fn(),
        // The registry knows uStale (the api held its token) but not uOrphan.
        listMcpTokenSessionIds: () => ["uStale"],
        killSession
      })
    );

    // Seed a live session in the Map (uStale) the cli-runner will report DEAD.
    await manager.ensureSession("uStale", "Ben");
    expect(engines).toHaveLength(1);
    const staleEngine = engines[0]!;

    // cli-runner reports only uOrphan alive: uStale is stale (Map has it, liveKeys does not),
    // uOrphan is an api-unknown live mux session that step 4 must reap by name.
    await manager.reconcileLiveSessions(new Set(["uOrphan"]));

    // Step 3 used the guard-bypassing killSession for the stale key, NOT the gated engine.kill().
    expect(killSession).toHaveBeenCalledWith("uStale:drawer");
    expect(staleEngine.kill).not.toHaveBeenCalled();
    // The stale session was still dropped and its token revoked despite the kill path.
    expect(revokeMcpToken).toHaveBeenCalledWith("uStale:drawer");
    // Step 4 still fired (it was NOT aborted by a step-3 throw): the api-unknown orphan was
    // reaped by mux name.
    expect(killSession).toHaveBeenCalledWith("uOrphan");

    // Proof the Map entry is gone: a fresh ensureSession relaunches a NEW engine (launches twice).
    await manager.ensureSession("uStale", "Ben");
    expect(engines).toHaveLength(2);
    expect(engineFactory).toHaveBeenCalledTimes(2);
  });
});

describe("ChatSessionManager maintenance mutex (#342 §5.4)", () => {
  it("serializes reconcileLiveSessions and reapIdle (mutually exclusive)", async () => {
    const events: string[] = [];
    // An engine whose kill records ordering so we can prove no interleave.
    const makeEngine = (label: string) => ({
      provider: "anthropic" as const,
      launch: vi.fn().mockResolvedValue({ offset: 0 }),
      submit: vi.fn().mockResolvedValue(undefined),
      readNew: vi.fn().mockResolvedValue({ records: [], offset: 0, complete: true }),
      isAlive: vi.fn().mockResolvedValue(true),
      kill: vi.fn().mockImplementation(async () => {
        events.push(`kill-start:${label}`);
        await new Promise((r) => setTimeout(r, 5));
        events.push(`kill-end:${label}`);
      }),
      interrupt: vi.fn().mockResolvedValue(undefined)
    });

    const reconcileMcpTokens = vi.fn().mockImplementation(() => {
      events.push("reconcile-token-sweep");
    });

    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => makeEngine("reap"),
        idleMs: -1, // everything is "idle" so reapIdle kills it
        reconcileMcpTokens,
        listMcpTokenSessionIds: () => [],
        killSession: vi.fn().mockResolvedValue(undefined),
        persistence: {
          resolveActiveProvider: vi
            .fn()
            .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );
    await manager.ensureSession("u1", "Ben");

    // Fire both maintenance paths in the same tick; the mutex must run them serially.
    await Promise.all([manager.reapIdle(), manager.reconcileLiveSessions(new Set(["u1"]))]);

    // The reap's kill must fully complete before reconciliation's token sweep runs (or vice
    // versa) — never interleaved. Assert no token-sweep lands between a kill-start/kill-end.
    const reapStart = events.indexOf("kill-start:reap");
    const reapEnd = events.indexOf("kill-end:reap");
    const sweep = events.indexOf("reconcile-token-sweep");
    if (reapStart !== -1 && reapEnd !== -1 && sweep !== -1) {
      const sweepIsBetween = sweep > reapStart && sweep < reapEnd;
      expect(sweepIsBetween).toBe(false);
    }
  });
});

// #1081 H2: dropSessionsForProvider coverage moved to
// tests/unit/chat-session-manager-provider-drop.test.ts — this file was at the
// check:file-size 1000-line cap, and that block pushed it over.

describe("ChatSessionManager.runTurn idle watchdog (#456 Task A)", () => {
  /** A fake engine whose readNew returns a queued script of results. Used to model a
   *  long actively-producing turn (records on every poll) vs. a silent turn (no records). */
  class ScriptedReadEngine {
    readonly provider = "anthropic" as const;
    launchOpts: EngineLaunchOpts | null = null;
    readonly submitted: string[] = [];
    interrupted = false;
    killed = false;
    constructor(
      private readonly readScript: {
        records: TranscriptRecord[];
        offset: number;
        complete: boolean;
      }[]
    ) {}
    async launch(opts: EngineLaunchOpts): Promise<{ offset: number }> {
      this.launchOpts = opts;
      return { offset: 0 };
    }
    async submit(text: string): Promise<void> {
      this.submitted.push(text);
    }
    async readNew(
      afterOffset: number
    ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
      const next = this.readScript.shift();
      if (next) return next;
      return { records: [], offset: afterOffset, complete: true };
    }
    async isAlive(): Promise<boolean> {
      return !this.killed;
    }
    async kill(): Promise<void> {
      this.killed = true;
    }
    async interrupt(): Promise<void> {
      this.interrupted = true;
    }
  }

  /** Fake clock with manual advance; delay() inside runTurn is bypassed via pollMs:0. */
  function makeFakeClock(start = 0) {
    let t = start;
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      }
    };
  }

  function watchdogDeps(
    engine: ScriptedReadEngine,
    clock: ReturnType<typeof makeFakeClock>,
    idleWatchdogMs: number
  ) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      pollMs: 0,
      idleWatchdogMs,
      clock,
      persistence: {
        resolveActiveProvider: vi
          .fn()
          .mockResolvedValue({ provider: "anthropic", model: "sonnet" }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      }
    });
  }

  it("resets the idle deadline whenever readNew yields new records (long actively-producing turn does NOT trip watchdog)", async () => {
    // Engine emits records on every poll across a wall-time span FAR exceeding the idle window.
    // Each emission resets the watchdog; the turn completes normally.
    const clock = makeFakeClock(0);
    const idleMs = 1000;
    // 5 polls, each returns a thinking record, then a final reply. Wall time between polls > idleMs,
    // but since each poll emits records the watchdog must reset and never trip.
    const engine = new ScriptedReadEngine([
      { records: [{ kind: "thinking", text: "t1" }], offset: 10, complete: false },
      { records: [{ kind: "thinking", text: "t2" }], offset: 20, complete: false },
      { records: [{ kind: "thinking", text: "t3" }], offset: 30, complete: false },
      { records: [{ kind: "thinking", text: "t4" }], offset: 40, complete: false },
      { records: [{ kind: "reply", text: "done" }], offset: 50, complete: true }
    ]);
    const manager = new ChatSessionManager(watchdogDeps(engine, clock, idleMs));

    // Interleave clock advances with the poll loop: after submitTurn starts, we need the clock to
    // advance >idleMs between readNew calls. Since pollMs is 0, the loop spins synchronously across
    // awaits. To model wall-time passage we hook the engine's readNew to advance the clock.
    const origReadNew = engine.readNew.bind(engine);
    engine.readNew = async (off: number) => {
      clock.advance(idleMs + 100); // each poll is "later" than the idle window
      return origReadNew(off);
    };

    const received: TranscriptRecord[] = [];
    manager.subscribe("u1", (r) => received.push(r));
    const { reply } = await manager.submitTurn("u1", "Ben", "long question");

    expect(reply).toBe("done");
    // No watchdog status record was emitted (the turn completed normally).
    expect(
      received.find((r) => r.kind === "status" && /No response from the model/.test(r.text))
    ).toBeUndefined();
  });

  it("trips the idle watchdog after a silent window and emits an accurate status record (no TIMEOUT_MESSAGE)", async () => {
    // Engine emits nothing across polls whose combined wall time exceeds the idle window.
    const clock = makeFakeClock(0);
    const idleMs = 500;
    // The engine returns empty records + complete:false forever until the watchdog breaks the loop.
    // readScript is empty → readNew falls through to the default {records:[], complete:true}, which
    // would end the turn immediately. To model a wedged engine, override readNew to never complete.
    const engine = new ScriptedReadEngine([]);
    engine.readNew = async (off: number) => {
      clock.advance(idleMs + 50); // each silent poll pushes wall time past the idle window
      return { records: [], offset: off, complete: false };
    };
    const manager = new ChatSessionManager(watchdogDeps(engine, clock, idleMs));

    const received: TranscriptRecord[] = [];
    manager.subscribe("u1", (r) => received.push(r));
    const { reply } = await manager.submitTurn("u1", "Ben", "hello?");

    // The watchdog tripped: reply is empty (no reply was ever produced).
    expect(reply).toBe("");
    // An accurate status record was emitted.
    const status = received.find((r) => r.kind === "status");
    expect(status).toBeDefined();
    expect(status!.text).toMatch(/No response from the model for \d+ seconds — ending turn\./);
    // The broken TIMEOUT_MESSAGE never appears.
    expect(received.find((r) => /Chat timed out/.test(r.text))).toBeUndefined();
    // recordTurn was NOT called (no reply was produced).
    expect(
      (manager as unknown as { deps: { persistence: { recordTurn: ReturnType<typeof vi.fn> } } })
        .deps.persistence.recordTurn
    ).not.toHaveBeenCalled();
  });
});
