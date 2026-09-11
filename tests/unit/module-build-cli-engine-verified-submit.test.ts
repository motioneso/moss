import { describe, expect, it, vi } from "vitest";

import type { Multiplexer } from "../../packages/ai/src/adapters/multiplexer.js";
import { CliChatEngineImpl } from "../../packages/chat/src/live/module-build-cli-engine.js";
import type { VerifiedSubmitError } from "../../packages/chat/src/live/module-build-cli-engine.js";
import { CODEX_IDENTITY_FILENAME } from "../../packages/chat/src/live/private-transcript-cleanup.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";

function makeIo() {
  return {
    run: vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" }),
    sleep: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined)
  };
}

function stateMachineMux(opts: {
  readonly panes: readonly string[];
  readonly onPaste?: () => void;
  readonly onEnter?: () => void;
}): Multiplexer & {
  readonly clearComposer: ReturnType<typeof vi.fn>;
  readonly clearComposerHard: ReturnType<typeof vi.fn>;
  readonly capturePane: ReturnType<typeof vi.fn>;
  readonly paste: ReturnType<typeof vi.fn>;
  readonly pressEnter: ReturnType<typeof vi.fn>;
  readonly kill: ReturnType<typeof vi.fn>;
} {
  const panes = [...opts.panes];
  const capturePane = vi.fn(async () => panes.shift() ?? panes.at(-1) ?? "");
  return {
    kind: "tmux",
    open: vi.fn().mockResolvedValue("pane-1"),
    clearComposer: vi.fn().mockResolvedValue(undefined),
    clearComposerHard: vi.fn().mockResolvedValue(undefined),
    capturePane,
    paste: vi.fn(async () => opts.onPaste?.()),
    pressEnter: vi.fn(async () => opts.onEnter?.()),
    submit: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    isAlive: vi.fn().mockResolvedValue(true),
    kill: vi.fn().mockResolvedValue(undefined),
    attachCommand: vi.fn().mockReturnValue("tmux attach -t pane-1")
  };
}

function claudeUser(text: string): string {
  return JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
}

describe("CliChatEngineImpl — verified interactive submit", () => {
  const empty = "\u001b[1m❯\u001b[0m\u00a0\n";

  it("presses Enter once only after exact ECHO and exact post-cursor ACK", async () => {
    let transcript = claudeUser("older turn");
    const mux = stateMachineMux({
      panes: [empty, "❯ exact payload\n"],
      onEnter: () => {
        transcript += claudeUser("exact payload");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "verified-success", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/verified-success", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "11111111-1111-4111-8111-111111111111",
      text: "exact payload",
      signal: new AbortController().signal
    });

    expect(mux.clearComposer).toHaveBeenCalledTimes(1);
    // #1170: hard clear (Ctrl+C) must never fire when the soft clear already emptied the
    // composer — on an empty composer it arms claude's press-again-to-exit state.
    expect(mux.clearComposerHard).not.toHaveBeenCalled();
    expect(mux.paste).toHaveBeenCalledTimes(1);
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
    expect(mux.kill).not.toHaveBeenCalled();
  });

  it("hard-clears a stuck multiline composer that C-u cannot empty (#1170)", async () => {
    // Probed live on claude 2.1.215: C-u clears only the CURRENT line, so a stuck
    // multiline paste (every attachment turn is multiline) survives clearComposer and
    // pre-fix the emptiness gate failed the whole turn ("chat input unavailable").
    let transcript = "";
    const stuck = "❯ stuck line one\n  stuck line two\n";
    const mux = stateMachineMux({
      // Capture order: post-C-u observe (still stuck) → post-C-c observe (empty) → echo.
      panes: [stuck, empty, "❯ next turn\n"],
      onEnter: () => {
        transcript += claudeUser("next turn");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "hard-clear", io, { mux, echoMs: 0 });
    await engine.launch({ neutralDir: "/tmp/hard-clear", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "66666666-6666-4666-8666-666666666666",
      text: "next turn",
      signal: new AbortController().signal
    });

    expect(mux.clearComposer).toHaveBeenCalledTimes(1);
    expect(mux.clearComposerHard).toHaveBeenCalledTimes(1);
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
    expect(mux.kill).not.toHaveBeenCalled();
  });

  it("re-presses Enter when the ack never lands and the composer still holds the text (#1162)", async () => {
    // Swallowed-Enter recovery: echo verified, Enter sent, but no user record reaches the
    // transcript and the text still sits in the composer ⇒ press Enter again (bounded).
    let transcript = "";
    let enters = 0;
    const mux = stateMachineMux({
      // Captures: emptiness gate → echo observe → nudge composer probe (still holding).
      panes: [empty, "❯ exact payload\n", "❯ exact payload\n"],
      onEnter: () => {
        enters += 1;
        // First Enter is "swallowed" (no ack); the nudge's second Enter lands it.
        if (enters === 2) transcript += claudeUser("exact payload");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "enter-nudge", io, {
      mux,
      echoMs: 0,
      nudgeAfterMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/enter-nudge", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "77777777-7777-4777-8777-777777777777",
      text: "exact payload",
      signal: new AbortController().signal
    });

    expect(mux.pressEnter).toHaveBeenCalledTimes(2);
    expect(mux.kill).not.toHaveBeenCalled();
  });

  it("never re-presses Enter when the composer is empty (submitted, ack lagging) (#1162)", async () => {
    // Empty composer ⇒ the text WAS submitted; re-pressing there is the duplicate-turn
    // hazard, so the nudge must fall through to the plain unbounded ack wait instead.
    const io = makeIo();
    const mux = stateMachineMux({
      // Captures: emptiness gate → echo observe → nudge composer probe (EMPTY = submitted).
      panes: [empty, "❯ exact payload\n", empty]
    });
    // Ack appears only AFTER the nudge probe has captured the empty composer (3rd capture),
    // forcing the bounded wait to time out once and the fall-through unbounded wait to win.
    io.readFile.mockImplementation(async () =>
      mux.capturePane.mock.calls.length >= 3 ? claudeUser("exact payload") : ""
    );
    const engine = new CliChatEngineImpl("anthropic", "ack-lag", io, {
      mux,
      echoMs: 0,
      nudgeAfterMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/ack-lag", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "88888888-8888-4888-8888-888888888889",
      text: "exact payload",
      signal: new AbortController().signal
    });

    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
  });

  it("allows one clear-first re-paste, then still presses Enter only once", async () => {
    let transcript = "";
    const mux = stateMachineMux({
      panes: [empty, "❯ wrong\n", empty, "❯ exact payload\n"],
      onEnter: () => {
        transcript += claudeUser("exact payload");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "verified-repaste", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/verified-repaste", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "22222222-2222-4222-8222-222222222222",
      text: "exact payload",
      signal: new AbortController().signal
    });

    expect(mux.clearComposer).toHaveBeenCalledTimes(2);
    expect(mux.paste).toHaveBeenCalledTimes(2);
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact post-cursor Codex user_message on a launch-valid rollout", async () => {
    const neutralDir = "/tmp/verified-codex";
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    let transcript =
      JSON.stringify({
        type: "session_meta",
        payload: { id: uuid, cwd: neutralDir, timestamp: new Date().toISOString() }
      }) + "\n";
    let enters = 0;
    let markerPersistedBeforeUserEnter = false;
    const io = makeIo();
    const mux = stateMachineMux({
      panes: [
        "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
        "› /status\n",
        `│  Session:  ${uuid}  │\n`,
        "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
        "› exact payload\n"
      ],
      onEnter: () => {
        enters += 1;
        if (enters === 1) return;
        markerPersistedBeforeUserEnter = io.writeFile.mock.calls.some((call: unknown[]) =>
          String(call[0]).endsWith(`${CODEX_IDENTITY_FILENAME}.tmp`)
        );
        transcript +=
          JSON.stringify({
            type: "event_msg",
            payload: { type: "user_message", message: "exact payload" }
          }) + "\n";
      }
    });
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("openai-compatible", "verified-codex", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir, personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "88888888-8888-4888-8888-888888888888",
      text: "exact payload",
      signal: new AbortController().signal
    });

    expect(mux.pressEnter).toHaveBeenCalledTimes(2);
    expect(markerPersistedBeforeUserEnter).toBe(true);
    expect(io.run.mock.calls.some((call: unknown[]) => call[0] === "ls")).toBe(false);
  });

  it("fails before paste without killing when empty composer cannot be observed", async () => {
    const mux = stateMachineMux({ panes: ["❯ private draft\n"] });
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "verified-no-empty", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/verified-no-empty", personaPath: "/p.md" });

    const error = await engine
      .verifiedSubmit({
        attemptId: "33333333-3333-4333-8333-333333333333",
        text: "payload",
        signal: new AbortController().signal
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject<Partial<VerifiedSubmitError>>({ code: "unavailable" });
    expect(mux.paste).not.toHaveBeenCalled();
    expect(mux.pressEnter).not.toHaveBeenCalled();
    expect(mux.kill).not.toHaveBeenCalled();
  });

  it("clears a canceled pasted payload before failing unavailable", async () => {
    const controller = new AbortController();
    const mux = stateMachineMux({
      panes: [empty, empty],
      onPaste: () => controller.abort()
    });
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "verified-cancel-paste", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/verified-cancel-paste", personaPath: "/p.md" });

    const error = await engine
      .verifiedSubmit({
        attemptId: "44444444-4444-4444-8444-444444444444",
        text: "private payload",
        signal: controller.signal
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject<Partial<VerifiedSubmitError>>({ code: "unavailable" });
    expect(mux.clearComposer).toHaveBeenCalledTimes(2);
    expect(mux.pressEnter).not.toHaveBeenCalled();
    expect(mux.kill).not.toHaveBeenCalled();
  });

  it("kills and returns delivery_unknown when canceled after Enter, despite a late ACK", async () => {
    let transcript = "";
    const controller = new AbortController();
    const mux = stateMachineMux({
      panes: [empty, "❯ exact payload\n"],
      onEnter: () => {
        transcript += claudeUser("exact payload");
        controller.abort();
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const engine = new CliChatEngineImpl("anthropic", "verified-entered", io, {
      mux,
      echoMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/verified-entered", personaPath: "/p.md" });

    const error = await engine
      .verifiedSubmit({
        attemptId: "55555555-5555-4555-8555-555555555555",
        text: "exact payload",
        signal: controller.signal
      })
      .catch((err: unknown) => err);

    expect(error).toMatchObject<Partial<VerifiedSubmitError>>({ code: "delivery_unknown" });
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
    expect(mux.kill).toHaveBeenCalledTimes(1);
  });

  it("fails fast to delivery_unknown (never hangs) when the composer never empties across all nudges (#1226)", async () => {
    // Live #1226 blocker: initial Enter plus both bounded nudges left a long multiline
    // composer still holding the text and no transcript ack ever landed. Pre-fix, once the
    // MAX_ENTER_NUDGES loop exhausted without the composer going empty, the code fell
    // through to a genuinely UNBOUNDED waitForUserAck — with no ack ever arriving and the
    // signal never aborted, that spins forever. A composer still full after every real
    // Enter press means delivery failed, not "ack lagging", so this must fail fast instead
    // of waiting on an ack that will never come.
    const stuckMultiline = "❯ stuck line one\n  stuck line two\n  stuck line three\n";
    const mux = stateMachineMux({
      // Captures: emptiness gate (empty) → echo observe (exact match) → nudge probes
      // (repeats the last pane — stuck — for every subsequent capture).
      panes: [empty, "❯ exact payload\n", stuckMultiline]
    });
    const io = makeIo();
    io.readFile.mockResolvedValue(""); // no ack ever reaches the transcript
    // Pre-fix this drives a genuinely unbounded poll loop. A microtask-resolved sleep would
    // starve the event loop and OOM the worker before the race timer below ever fires — a
    // real (if tiny) macrotask tick lets the race actually observe the hang.
    io.sleep.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 1)));
    const engine = new CliChatEngineImpl("anthropic", "stuck-composer", io, {
      mux,
      echoMs: 0,
      nudgeAfterMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/stuck-composer", personaPath: "/p.md" });

    const RACE_DEADLINE_MS = 200;
    const outcome = await Promise.race([
      engine
        .verifiedSubmit({
          attemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          text: "exact payload",
          signal: new AbortController().signal
        })
        .then(
          () => ({ kind: "resolved" as const }),
          (err: unknown) => ({ kind: "rejected" as const, err })
        ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), RACE_DEADLINE_MS)
      )
    ]);

    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.err).toMatchObject<Partial<VerifiedSubmitError>>({
        code: "delivery_unknown"
      });
    }
    // Initial Enter + exactly two bounded nudges — never a third.
    expect(mux.pressEnter).toHaveBeenCalledTimes(3);
    expect(mux.kill).toHaveBeenCalledTimes(1);
  });

  it("rejects instead of hanging when an individual mux call never settles — pressEnter (#1226 relay-4/5/6)", async () => {
    // Relay-4 live finding: composer held the full pasted payload, un-submitted, no
    // spinner, for 300+s — the #1226 fix above (MAX_ENTER_NUDGES exhaustion) never even
    // engaged. Root cause: every "bounded" loop in this file (observePane's echoMs
    // deadline, waitForUserAckWithEnterNudge's nudgeAfterMs) only bounds the polling
    // loop's OWN sleep/deadline check — it never wrapped the individual
    // `await this.mux.*(handle)` call inside it with its own timeout. If that single
    // RPC (here: pressEnter at module-build-cli-engine.ts ~419) never settles, execution never
    // reaches the nudge loop at all, so its 7s/14s/21s bound never fires. Relay-6 added
    // `raceMux` (a per-call `muxCallMs` timeout) around every such RPC, so the hang is
    // now provably bounded: this test proves the fix, not the bug.
    const mux = stateMachineMux({ panes: [empty, "❯ exact payload\n"] });
    (mux.pressEnter as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}));
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "hung-press-enter", io, {
      mux,
      echoMs: 0,
      nudgeAfterMs: 0,
      muxCallMs: 0
    });
    await engine.launch({ neutralDir: "/tmp/hung-press-enter", personaPath: "/p.md" });

    const RACE_DEADLINE_MS = 200;
    const outcome = await Promise.race([
      engine
        .verifiedSubmit({
          attemptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          text: "exact payload",
          signal: new AbortController().signal
        })
        .then(
          () => ({ kind: "resolved" as const }),
          (err: unknown) => ({ kind: "rejected" as const, err })
        ),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), RACE_DEADLINE_MS)
      )
    ]);

    // pressEnter fires after `entered = true` is set, so the existing entered/pasted
    // classification in verifiedSubmit's catch block turns raceMux's plain timeout Error
    // into a delivery_unknown VerifiedSubmitError — the real rejection wins the inner
    // race well inside RACE_DEADLINE_MS, so the outer harness timeout arm stays unhit.
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") {
      expect(outcome.err).toMatchObject<Partial<VerifiedSubmitError>>({
        code: "delivery_unknown"
      });
    }
    expect(mux.pressEnter).toHaveBeenCalledTimes(1);
  });

  it("keeps the original Codex marker when invalidation purge cannot prove identity", async () => {
    const uuid = "019f5af9-3c61-7f72-af47-09514db9892c";
    const neutralDir = "/tmp/verified-codex-failed-purge";
    const controller = new AbortController();
    let enters = 0;
    const mux = stateMachineMux({
      panes: [
        "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
        "› /status\n",
        `│  Session:  ${uuid}  │\n`,
        "\u001b[1m›\u001b[0m \u001b[2mUse /skills\u001b[0m\n",
        "› private payload\n"
      ],
      onEnter: () => {
        enters += 1;
        if (enters === 2) controller.abort();
      }
    });
    const io = makeIo();
    io.readFile.mockResolvedValue(
      JSON.stringify({ type: "session_meta", payload: { id: uuid, cwd: "/other/session" } })
    );
    const engine = new CliChatEngineImpl("openai-compatible", "codex-failed-purge", io, {
      mux,
      echoMs: 0,
      homeBase: "/host-home"
    });
    await engine.launch({ neutralDir, personaPath: "/p.md" });

    await expect(
      engine.verifiedSubmit({
        attemptId: "99999999-9999-4999-8999-999999999999",
        text: "private payload",
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: "delivery_unknown" });

    expect(mux.kill).toHaveBeenCalledTimes(1);
    expect(
      io.writeFile.mock.calls.some((call) => String(call[0]).includes(CODEX_IDENTITY_FILENAME))
    ).toBe(true);
    expect(io.run.mock.calls).not.toContainEqual(["rm", ["-rf", neutralDir]]);
  });

  it("reports composer_discarded when pre-clear composer holds stuck user input (#1157)", async () => {
    // #1157: Ben's "try again" sat pasted-but-unsubmitted ~10min; the next turn's
    // clearComposer silently discarded it. The pre-clear probe must surface the loss.
    let transcript = "";
    const mux = stateMachineMux({
      // Pane order: pre-clear probe (STUCK text), post-clear empty check, echo check.
      panes: ["❯ stuck earlier input\n", empty, "❯ next turn\n"],
      onEnter: () => {
        transcript += claudeUser("next turn");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const events: unknown[] = [];
    const engine = new CliChatEngineImpl("anthropic", "diag-stuck", io, {
      mux,
      echoMs: 0,
      onDiagnostic: (event) => events.push(event)
    });
    await engine.launch({ neutralDir: "/tmp/diag-stuck", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "33333333-3333-4333-8333-333333333333",
      text: "next turn",
      signal: new AbortController().signal
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "composer_discarded" });
    // Privacy: char count only — the discarded text may be private-session content.
    expect(Object.keys(events[0] as object).sort()).toEqual(["kind", "paneChars"]);
    expect((events[0] as { paneChars: number }).paneChars).toBeGreaterThan(0);
  });

  it("stays silent when the pre-clear composer is already empty (#1157)", async () => {
    let transcript = "";
    const mux = stateMachineMux({
      panes: [empty, empty, "❯ next turn\n"],
      onEnter: () => {
        transcript += claudeUser("next turn");
      }
    });
    const io = makeIo();
    io.readFile.mockImplementation(async () => transcript);
    const events: unknown[] = [];
    const engine = new CliChatEngineImpl("anthropic", "diag-clean", io, {
      mux,
      echoMs: 0,
      onDiagnostic: (event) => events.push(event)
    });
    await engine.launch({ neutralDir: "/tmp/diag-clean", personaPath: "/p.md" });

    await engine.verifiedSubmit({
      attemptId: "44444444-4444-4444-8444-444444444444",
      text: "next turn",
      signal: new AbortController().signal
    });

    expect(events).toHaveLength(0);
  });
});

describe("CliChatEngineImpl — plain submit mux-failure classification (#1157)", () => {
  it("maps a mux delivery failure to CliChatUnavailableError so runTurn can heal", async () => {
    // #1157: engine terminal died out-of-band (pane_not_found from herdr). Pre-fix the
    // in-process engine rethrew the raw transport Error, so chat-session-manager's heal
    // branch (which keys on CliChatUnavailableError) never fired — only the RPC path got
    // the typed classification from cli-runner. This pins the in-process parity mapping.
    const mux = stateMachineMux({ panes: ["[1m❯[0m \n"] });
    (mux.submit as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('herdr send-text failed (code 1): {"error":{"code":"pane_not_found"}}')
    );
    const io = makeIo();
    const engine = new CliChatEngineImpl("anthropic", "submit-dead-pane", io, { mux, echoMs: 0 });
    // Launch first: without a live handle, requireHandle() throws before reaching the
    // mux call and the assertion would false-pass on the wrong error.
    await engine.launch({ neutralDir: "/tmp/submit-dead-pane", personaPath: "/p.md" });

    await expect(engine.submit("hello")).rejects.toBeInstanceOf(CliChatUnavailableError);
  });
});
