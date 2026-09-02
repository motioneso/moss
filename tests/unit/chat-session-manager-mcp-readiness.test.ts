import { describe, expect, it, vi } from "vitest";
import { ChatSessionManager } from "../../packages/chat/src/live/chat-session-manager.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { FakeEngine, makeMinimalDeps } from "./chat-session-manager.test.js";

// #2159 — regression for the tools/list readiness race: nothing previously tied "the session
// is ready for a message" to "the MCP client's first tools/list has landed". This proves
// launchSession now awaits `waitForToolsListReady` (keyed off the minted token) AFTER
// engine.launch() and BEFORE the session becomes visible to ensureSession's caller — a
// manually-controlled (never auto-resolving) promise lets the test observe the gate actually
// blocking, not just get lucky on ordering.
//
// Split out of chat-session-manager.test.ts to keep both files under the repo's 1000-line cap.
describe("ChatSessionManager tools/list readiness gate (#2159)", () => {
  it("does not resolve ensureSession until waitForToolsListReady resolves", async () => {
    const engine = new FakeEngine(0);
    let releaseReady: (value: boolean) => void = () => {
      throw new Error("releaseReady called before it was assigned");
    };
    const readyGate = new Promise<boolean>((resolve) => {
      releaseReady = resolve;
    });
    const waitForToolsListReady = vi.fn().mockReturnValue(readyGate);
    const mintMcpToken = vi
      .fn()
      .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        mintMcpToken,
        waitForToolsListReady,
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
      }) as never
    );

    let resolved = false;
    const ensured = manager.ensureSession("u1", "Ben").then((session) => {
      resolved = true;
      return session;
    });

    // Engine launch already happened; the gate is what's holding the session back.
    await vi.waitFor(() => expect(engine.launchOpts).not.toBeNull());
    expect(resolved).toBe(false);

    releaseReady(true);
    await ensured;

    expect(resolved).toBe(true);
    expect(waitForToolsListReady).toHaveBeenCalledWith("jst_x");
  });

  it("proceeds without a token (no mintMcpToken configured) — no gate to wait on", async () => {
    const engine = new FakeEngine(0);
    const waitForToolsListReady = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        waitForToolsListReady,
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
      }) as never
    );

    await manager.ensureSession("u1", "Ben");

    expect(waitForToolsListReady).not.toHaveBeenCalled();
  });

  it("skips the readiness wait for a bounded-fallback (print/one-shot) engine — launch() never starts an MCP client for it", async () => {
    const engine = new FakeEngine(0);
    const waitForToolsListReady = vi.fn().mockReturnValue(
      new Promise(() => {
        // Never resolves — proves the gate is not awaited for this engine shape at all.
      })
    );
    const mintMcpToken = vi
      .fn()
      .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        mintMcpToken,
        waitForToolsListReady,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "google", model: "gemini" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn: vi.fn().mockResolvedValue(undefined),
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      }) as never
    );

    await manager.ensureSession("u1", "Ben");

    expect(waitForToolsListReady).not.toHaveBeenCalled();
    expect(engine.killed).toBe(false);
  });

  it("rejects instead of letting the first message through when waitForToolsListReady times out (resolves false)", async () => {
    const engine = new FakeEngine(0);
    const waitForToolsListReady = vi.fn().mockResolvedValue(false);
    const mintMcpToken = vi
      .fn()
      .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" });
    const revokeMcpToken = vi.fn();
    const manager = new ChatSessionManager(
      makeMinimalDeps({
        engineFactory: () => engine,
        mintMcpToken,
        revokeMcpToken,
        waitForToolsListReady,
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
      }) as never
    );

    await expect(manager.ensureSession("u1", "Ben")).rejects.toThrow(CliChatUnavailableError);

    // #2164 QA — a timeout must not leak the process it just started or the token it just
    // minted: both the engine and the token registration must be torn down before the throw.
    expect(engine.killed).toBe(true);
    expect(revokeMcpToken).toHaveBeenCalledWith("u1:drawer");
  });
});

// #2164 — a bounded-fallback engine (`ClaudePrintChatEngine`) never starts its MCP client
// during launch(), so the readiness gate above never runs for it (see the "skips the
// readiness wait" case). That left a second, uncaught race: this engine starts its MCP
// client per turn, inside submit(), so a turn can finish and answer the user — with no tool
// call — before the CLI process ever attached the MCP tools at all. This proves the one-shot
// submit path now checks tools-list readiness before accepting a tool-less reply.
describe("ChatSessionManager one-shot tool-attachment guard (#2164)", () => {
  function boundedFallbackDeps(
    engine: FakeEngine,
    overrides: Partial<ConstructorParameters<typeof ChatSessionManager>[0]> = {}
  ) {
    return makeMinimalDeps({
      engineFactory: () => engine,
      pollMs: 0,
      mintMcpToken: vi
        .fn()
        .mockResolvedValue({ token: "jst_x", mcpServerUrl: "http://localhost:3000/api/mcp" }),
      persistence: {
        resolveActiveProvider: vi.fn().mockResolvedValue({
          provider: "anthropic",
          model: "sonnet",
          executionMode: "non_interactive"
        }),
        listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
        recordTurn: vi.fn().mockResolvedValue(undefined),
        openNewConversation: vi.fn().mockResolvedValue(undefined),
        getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
        touchExistingThread: vi.fn().mockResolvedValue(true)
      },
      ...overrides
    }) as never;
  }

  it("rejects a tool-less reply instead of persisting it when no NEW tools/list observation lands for this turn", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          { kind: "reply", text: "I don't have the Jarv1s MCP tools available in this session." }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    // #2164 r21 — count never advances past the baseline, so the guard must time out. A
    // monotonically-advancing fake clock (rather than a fixed "second call" value, which other
    // clock.now() reads earlier in the turn — lastActivity stamps, emission timestamps — would
    // consume before the guard's own deadline check ever runs) keeps this test from waiting out
    // the real 10s timeout regardless of how many unrelated clock reads precede it.
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    let clockNow = 0;
    const clock = { now: vi.fn(() => (clockNow += 3_000)) };
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        clock,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).rejects.toThrow(
      CliChatUnavailableError
    );

    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_x");
    expect(recordTurn).not.toHaveBeenCalled();
  });

  it("accepts a tool-less reply once a NEW tools/list observation lands after this turn's submit", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "sure, here's the weather" }], offset: 10, complete: true }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    // #2164 r21 — first call is the pre-submit baseline (0); every call after that reports a
    // fresh attach landed for this turn (1).
    const getToolsListObservationCount = vi.fn().mockReturnValueOnce(0).mockReturnValue(1);
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "what's the weather?")).resolves.toMatchObject({
      reply: "sure, here's the weather"
    });

    expect(recordTurn).toHaveBeenCalled();
  });

  it("Gemini QA fix (r19) — accepts a tool-less reply without waiting; Gemini never registers MCP tools so tools/list can never land", async () => {
    const engine = new FakeEngine(0, [
      { records: [{ kind: "reply", text: "sure, here's the weather" }], offset: 10, complete: true }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const waitForToolsListReady = vi.fn().mockReturnValue(
      new Promise(() => {
        // Never resolves — proves the guard is not awaited for Gemini at all.
      })
    );
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        waitForToolsListReady,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({ provider: "google", model: "gemini" }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "what's the weather?")).resolves.toMatchObject({
      reply: "sure, here's the weather"
    });

    expect(waitForToolsListReady).not.toHaveBeenCalled();
    expect(recordTurn).toHaveBeenCalled();
  });

  it("never calls waitForToolsListReady when a tool was actually invoked this turn", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          { kind: "tool", text: "calling sports.retrySource", toolName: "sports.retrySource" },
          { kind: "reply", text: "retried it" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const waitForToolsListReady = vi.fn();
    const manager = new ChatSessionManager(boundedFallbackDeps(engine, { waitForToolsListReady }));

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).resolves.toMatchObject(
      { reply: "retried it" }
    );

    expect(waitForToolsListReady).not.toHaveBeenCalled();
  });

  // #2164 r21 security correction — the MCP path grants "Read,Glob,Grep" alongside the
  // mcp__jarvis__* tools, so a turn that only used those native tools was previously
  // mistaken for proof the MCP client attached (`invokedToolNames.size === 0` went false on
  // ANY tool, native or MCP). This is the exact gap #2164 exists to catch. Must fail on
  // aea0f27f (before this correction) and pass after it.
  it("fails closed for a native-tool-only turn (Read/Glob/Grep) with no new tools/list observation", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          { kind: "tool", text: "reading a file", toolName: "Read" },
          { kind: "tool", text: "listing files", toolName: "Glob" },
          { kind: "tool", text: "searching text", toolName: "Grep" },
          { kind: "reply", text: "here's what I found" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    // Count never advances past the baseline, so the guard must time out and fail closed —
    // same monotonically-advancing fake clock pattern as the no-tool-call case above.
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    let clockNow = 0;
    const clock = { now: vi.fn(() => (clockNow += 3_000)) };
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        clock,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "read this file for me")).rejects.toThrow(
      CliChatUnavailableError
    );

    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_x");
    expect(recordTurn).not.toHaveBeenCalled();
  });

  // #2164 r21 correction — a call that was ATTEMPTED and then REJECTED (`No such tool
  // available`) must not count as attachment proof. Before the correction, the mere presence
  // of an `mcp__`-prefixed name in `invokedToolNames` skipped the gate regardless of whether
  // the call actually succeeded.
  it("still runs the readiness gate when the only mcp__ activity this turn was rejected", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          {
            kind: "tool",
            text: "calling the sports retry tool",
            toolName: "mcp__jarvis__sports_confirmSourceRecipe",
            toolCallId: "toolu_1"
          },
          { kind: "tool", text: "", toolCallId: "toolu_1", rejected: true },
          { kind: "reply", text: "here's what I found" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    let clockNow = 0;
    const clock = { now: vi.fn(() => (clockNow += 3_000)) };
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        clock,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).rejects.toThrow(
      CliChatUnavailableError
    );

    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_x");
    expect(recordTurn).not.toHaveBeenCalled();
  });

  // Guard against over-tightening: an actual mcp__ tool invocation must still short-circuit
  // the gate even with no new observation recorded this turn. Updated for #2164 r22: the record
  // now carries a `toolCallId`, the shape the real engine produces since the r22 seam fix —
  // an id-less attempt no longer counts (see the next test).
  it("still bypasses the gate for an mcp__jarvis__* tool invocation with no new tools/list observation", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          {
            kind: "tool",
            text: "calling the sports retry tool",
            toolName: "mcp__jarvis__sports_retry_source",
            toolCallId: "toolu_bypass1"
          },
          { kind: "reply", text: "retried it" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).resolves.toMatchObject(
      { reply: "retried it" }
    );

    // Called once to capture the pre-turn baseline (unconditional); the mcp__ bypass means the
    // gate never re-polls it waiting for a new observation.
    expect(getToolsListObservationCount).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalled();
  });

  // #2164 r22 security correction — the reader-to-manager seam fix (item 1) means an id-less
  // `mcp__` attempt can now only happen for a call the real engine never actually observed an
  // id for. An attempt with no call id must not count as attachment proof and must still run
  // the readiness gate, closing the same hole the "no such tool" rejection case closes.
  it("still runs the readiness gate when the only mcp__ activity this turn has no call id", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          {
            kind: "tool",
            text: "calling the sports retry tool",
            toolName: "mcp__jarvis__sports_confirmSourceRecipe"
          },
          { kind: "reply", text: "here's what I found" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    let clockNow = 0;
    const clock = { now: vi.fn(() => (clockNow += 3_000)) };
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        clock,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).rejects.toThrow(
      CliChatUnavailableError
    );

    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_x");
    expect(recordTurn).not.toHaveBeenCalled();
  });

  // #2164 r22 security correction (item 2) — a rejection signal record (kind "tool", rejected
  // true, no toolName) must be consumed for gate bookkeeping only, never forwarded to
  // subscribers as an activity row. A native tool's errored result (has a toolName) is a real
  // activity step and must still be emitted; readiness behaviour for a native-only turn is
  // unchanged from the `aea0f27f` ruling.
  it("suppresses the rejection-signal record from emitted activity but still emits a native tool's own errored result", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          { kind: "tool", text: "reading a file", toolName: "Read" },
          { kind: "tool", text: "", toolCallId: "toolu_native1", rejected: true },
          { kind: "reply", text: "here's what I found" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    let clockNow = 0;
    const clock = { now: vi.fn(() => (clockNow += 3_000)) };
    const emitted: Array<{ kind: string }> = [];
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        clock,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );
    manager.subscribe("u1", (record) => {
      emitted.push(record);
    });

    await expect(manager.submitTurn("u1", "Ben", "read this file for me")).rejects.toThrow(
      CliChatUnavailableError
    );

    expect(emitted.some((r) => r.kind === "tool")).toBe(true);
    expect(emitted.filter((r) => r.kind === "tool").length).toBe(1);
    expect(getToolsListObservationCount).toHaveBeenCalledWith("jst_x");
    expect(recordTurn).not.toHaveBeenCalled();
  });

  // #2164 r23 security correction (item 1) — the r22 suppression keyed on `rejected`, but the
  // interactive Anthropic path (cli-chat-engine.ts) never sets that flag; it can still emit a
  // blank `{ kind: "tool", text: "" }` record with no toolName. The choke point must suppress
  // any nameless, textless tool record regardless of `rejected`, while a record that does carry
  // a toolName — even with empty text, e.g. an mcp__ call — is still a real activity step and
  // must still be emitted, and gate bookkeeping (mcp__ bypass) must stay unchanged.
  it("suppresses a nameless textless tool record with no rejected flag, but still emits and bypasses the gate for an mcp__ record with empty text", async () => {
    const engine = new FakeEngine(0, [
      {
        records: [
          { kind: "tool", text: "" },
          {
            kind: "tool",
            text: "",
            toolName: "mcp__jarvis__sports_retry_source",
            toolCallId: "toolu_blank1"
          },
          { kind: "reply", text: "retried it" }
        ],
        offset: 10,
        complete: true
      }
    ]);
    const recordTurn = vi.fn().mockResolvedValue(undefined);
    const getToolsListObservationCount = vi.fn().mockReturnValue(0);
    const emitted: Array<{ kind: string; toolName?: string; toolCallId?: string; text?: string }> =
      [];
    const manager = new ChatSessionManager(
      boundedFallbackDeps(engine, {
        getToolsListObservationCount,
        persistence: {
          resolveActiveProvider: vi.fn().mockResolvedValue({
            provider: "anthropic",
            model: "sonnet",
            executionMode: "non_interactive"
          }),
          listPriorTurns: vi.fn().mockResolvedValue({ recent: [], oldSummary: null }),
          recordTurn,
          openNewConversation: vi.fn().mockResolvedValue(undefined),
          getThreadContext: vi.fn().mockResolvedValue({ threadTitle: null, localTimezone: null }),
          touchExistingThread: vi.fn().mockResolvedValue(true)
        }
      })
    );
    manager.subscribe("u1", (record) => {
      emitted.push(record);
    });

    await expect(manager.submitTurn("u1", "Ben", "retry the sports source")).resolves.toMatchObject(
      { reply: "retried it" }
    );

    expect(emitted.filter((r) => r.kind === "tool")).toEqual([
      {
        kind: "tool",
        text: "",
        toolName: "mcp__jarvis__sports_retry_source",
        toolCallId: "toolu_blank1"
      }
    ]);
    // mcp__ bypass: the gate never re-polls waiting for a new observation.
    expect(getToolsListObservationCount).toHaveBeenCalledTimes(1);
    expect(recordTurn).toHaveBeenCalled();
  });
});
