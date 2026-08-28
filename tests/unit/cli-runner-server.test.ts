/**
 * cli-runner engine-host tests (§4.1.0a single-active-user gate, §4.5 kill-by-mux-name,
 * §4.6 listLiveSessions-by-mux, §6.5 startup CLEAN-SLATE sweep).
 *
 * The gate is the HARD RUNTIME GATE that stands in for deferred UID separation (#347):
 * AT MOST ONE live session across all sessionKeys while JARVIS_CLI_RUNNER_SINGLE_USER
 * is ON (default). These tests drive a controllable fake TmuxIo that models the mux's
 * live-session set so the gate's liveKeys = (mux ∪ reservations) is exercised end to end.
 */
import { createHmac, randomBytes } from "node:crypto";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import {
  BadSubmitAttemptError,
  CliChatEngineHost,
  VERIFIED_SUBMIT_DEADLINE_MS
} from "../../packages/cli-runner/src/engine-host.js";
import {
  serveConnection,
  type ByteChannel,
  type ConnectionDeps
} from "../../packages/cli-runner/src/connection.js";
import { TerminalHost } from "../../packages/cli-runner/src/terminal-host.js";
import type { InstallService } from "../../packages/cli-runner/src/install-service.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import {
  GEMINI_IDENTITY_FILENAME,
  CODEX_IDENTITY_FILENAME,
  codexTranscriptPath
} from "../../packages/chat/src/live/private-transcript-cleanup.js";
import {
  CliChatEngineImpl,
  SESSION_PREFIX,
  VerifiedSubmitError
} from "../../packages/chat/src/live/cli-chat-engine.js";
import { GeminiPrintChatEngine } from "../../packages/chat/src/live/gemini-print-chat-engine.js";
import { ClaudePrintChatEngine } from "../../packages/chat/src/live/claude-print-chat-engine.js";
import { ClaudePersistentRuntimeEngine } from "../../packages/chat/src/live/persistent-runtime-engine.js";
import { createChatEngine } from "../../packages/chat/src/live/engine-selection.js";
import {
  decodeFrame,
  encodeFrame,
  HELLO_PROOF_TAG_CLIENT,
  MAX_FRAME_BYTES,
  type RpcErr,
  type RpcHelloChallenge
} from "../../packages/chat/src/live/rpc-contract.js";

const NEUTRAL_BASE = "/data/cli-auth/chat";

afterEach(() => vi.restoreAllMocks());

/**
 * A fake TmuxIo that models a live-session Set. `tmux new-session` adds a session;
 * `tmux list-sessions` reports them; `kill-session` removes one. A `readFile` returns a
 * transcript that is immediately complete so the server-side drain finishes at once.
 * A `newSessionGate` promise (if supplied) lets a test hold a launch mid-flight.
 */
function makeFakeIo(opts: { newSessionGate?: Promise<void> } = {}): {
  io: TmuxIo;
  live: Set<string>;
  removedDirs: string[];
  run: ReturnType<typeof vi.fn>;
} {
  const live = new Set<string>();
  const removedDirs: string[] = [];
  const completeTranscript = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
  });

  const run = vi.fn(async (cmd: string, args: readonly string[]) => {
    if (cmd === "tmux") {
      const verb = args[0] === "-S" ? args[2] : args[0];
      if (verb === "new-session") {
        if (opts.newSessionGate) await opts.newSessionGate;
        const name = args[args.indexOf("-s") + 1]!;
        live.add(name);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "list-sessions") {
        return { code: 0, stdout: [...live].join("\n"), stderr: "" };
      }
      if (verb === "kill-session") {
        // §4.5 targets by EXACT name `=jarv1s-live-<key>` (the `=` forces tmux exact, non-prefix
        // resolution). The live Set stores bare session names, so strip a leading `=` to match.
        const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
        live.delete(name);
        return { code: 0, stdout: "", stderr: "" };
      }
      // send-keys, load-buffer, paste-buffer, has-session → ok
      if (verb === "has-session") {
        const name = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
        return { code: live.has(name) ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "rm") {
      const target = args[args.length - 1]!;
      removedDirs.push(target);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "ls") {
      // Used by the startup sweep's clearNeutralBase and by Codex transcript globbing.
      return { code: 1, stdout: "", stderr: "" };
    }
    // mkdir / chmod → ok
    return { code: 0, stdout: "", stderr: "" };
  });

  const io: TmuxIo = {
    run: run as unknown as TmuxIo["run"],
    readFile: vi.fn().mockResolvedValue(completeTranscript),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined)
  };
  return { io, live, removedDirs, run };
}

function makeHost(io: TmuxIo, singleUser = true): CliChatEngineHost {
  return new CliChatEngineHost({
    io,
    neutralBase: NEUTRAL_BASE,
    singleUser,
    cliPresent: async () => true,
    // The fake mux's open() is the default TmuxMultiplexer over `io`; no real tmux runs.
    launchTimeoutMs: 2_000
  });
}

function makeBootSweepIo(opts: { codexMismatch?: boolean } = {}): {
  io: TmuxIo;
  calls: string[];
  neutralBase: string;
  neutralDir: string;
  homeBase: string;
  codexPath: string;
  geminiChatsDir: string;
} {
  const calls: string[] = [];
  const neutralBase = "/data/cli-auth/chat";
  const neutralDir = `${neutralBase}/stale-user`;
  const homeBase = "/home/ben";
  const codexUuid = "019f5af9-3c61-7f72-af47-09514db9892c";
  const geminiUuid = "e099f770-a55c-432f-a9be-8cf254fd2d54";
  const geminiShortId = "stale-user";
  const codexPath = codexTranscriptPath(codexUuid, homeBase);
  // #2028 — the Gemini CLI names its own state directory by a short id that only exists in its
  // registry file, so the sweep has to read that file rather than compute the path.
  const geminiChatsDir = join(homeBase, ".gemini", "tmp", geminiShortId);

  const markerValues = new Map<string, string>([
    [`${neutralDir}/${CODEX_IDENTITY_FILENAME}`, `${codexUuid}\n`],
    [`${neutralDir}/${GEMINI_IDENTITY_FILENAME}`, `${geminiUuid}\n`],
    [
      join(homeBase, ".gemini", "projects.json"),
      JSON.stringify({ projects: { [neutralDir]: geminiShortId } })
    ],
    [
      codexPath,
      `${JSON.stringify({
        type: "session_meta",
        payload: {
          id: codexUuid,
          cwd: opts.codexMismatch ? `${neutralDir}-other` : neutralDir
        }
      })}\n`
    ]
  ]);

  const run = vi.fn(async (cmd: string, args: readonly string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd === "tmux") {
      if (args[0] === "list-sessions") return { code: 0, stdout: "", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "ls") {
      if (args[1] === neutralBase) return { code: 0, stdout: "stale-user\n", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    }
    if (cmd === "find") return { code: 0, stdout: `${codexPath}\n`, stderr: "" };
    if (cmd === "rm") return { code: 0, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });

  const readFile = vi.fn(async (path: string) => {
    const value = markerValues.get(path);
    if (value === undefined) throw new Error("ENOENT");
    return value;
  });

  return {
    io: {
      run: run as unknown as TmuxIo["run"],
      readFile: readFile as unknown as TmuxIo["readFile"],
      writeFile: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined)
    },
    calls,
    neutralBase,
    neutralDir,
    homeBase,
    codexPath,
    geminiChatsDir
  };
}

const launchParams = (provider: "anthropic" = "anthropic") => ({
  provider,
  personaText: "You are Jarvis."
});

describe("§4.1.0a single-active-user gate", () => {
  it("counts a persistent-runtime engine with no mux session as live", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    const persistent = createChatEngine("anthropic", "alice", io, {
      persistentRuntimeEnabled: true
    });
    expect(persistent).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    (host as unknown as { engines: Map<string, unknown> }).engines.set("alice", persistent);

    await expect(host.launch("bob", launchParams())).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );
  });

  it.each([
    ["anthropic", ClaudePrintChatEngine],
    ["google", GeminiPrintChatEngine]
  ] as const)(
    "counts a %s bounded-fallback engine as live and does not reap it",
    async (provider, Engine) => {
      const { io, live, run } = makeFakeIo();
      const host = makeHost(io);
      const bounded = createChatEngine(provider, "bounded", io, {
        executionMode: "non_interactive"
      });
      expect(bounded).toBeInstanceOf(Engine);
      (host as unknown as { engines: Map<string, unknown> }).engines.set("bounded", bounded);

      await expect(host.launch("other", launchParams())).rejects.toBeInstanceOf(
        CliChatUnavailableError
      );
      await host.startupSweep();

      expect(live).not.toContain(SESSION_PREFIX + "bounded");
      expect(run).not.toHaveBeenCalledWith(
        "tmux",
        expect.arrayContaining(["kill-session", "-t", "=" + SESSION_PREFIX + "bounded"])
      );
    }
  );

  it("rejects a 2nd launch for a DIFFERENT sessionKey while one is live; succeeds after kill", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);

    const first = await host.launch("alice", launchParams());
    expect(first).toEqual({ offset: expect.any(Number) });

    // A second, different user is rejected with `unavailable` while alice is live.
    await expect(host.launch("bob", launchParams())).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );

    // Re-launching the SAME live key is allowed (idempotent for that user).
    await expect(host.launch("alice", launchParams())).resolves.toBeDefined();

    // After alice is killed, bob can launch.
    await host.kill("alice");
    await expect(host.launch("bob", launchParams())).resolves.toBeDefined();
  });

  it("two CONCURRENT cross-key launches admit EXACTLY ONE (TOCTOU closed by the reservation)", async () => {
    // Hold both new-session calls behind a gate so both launches are in-flight at once.
    let openGate!: () => void;
    const gate = new Promise<void>((res) => {
      openGate = res;
    });
    const { io } = makeFakeIo({ newSessionGate: gate });
    const host = makeHost(io);

    const a = host.launch("alice", launchParams());
    const b = host.launch("bob", launchParams());
    // Attach the settle handler BEFORE the timing gap so the loser's rejection is never flagged as an
    // unhandled rejection while we wait out the admission tick (it rejects before allSettled is awaited).
    const settled = Promise.allSettled([a, b]);
    // Let both admissions run through the mutex, then release the mux-create.
    await new Promise((r) => setTimeout(r, 5));
    openGate();

    const results = await settled;
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(CliChatUnavailableError);
  });

  it("with the gate OFF, concurrent distinct keys both launch", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io, /* singleUser */ false);
    await expect(host.launch("alice", launchParams())).resolves.toBeDefined();
    await expect(host.launch("bob", launchParams())).resolves.toBeDefined();
    expect(host.liveEngineCount()).toBe(2);
  });
});

describe("§4.5 kill-by-mux-name + §4.6 listLiveSessions", () => {
  it("does not reap a registry-only engine as a mux orphan", async () => {
    const { io, live, run } = makeFakeIo();
    const host = makeHost(io);
    const persistent = createChatEngine("anthropic", "persistent", io, {
      persistentRuntimeEnabled: true
    });
    expect(persistent).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    (host as unknown as { engines: Map<string, unknown> }).engines.set("persistent", persistent);

    await host.startupSweep();

    expect(live).not.toContain(SESSION_PREFIX + "persistent");
    expect(run).not.toHaveBeenCalledWith(
      "tmux",
      expect.arrayContaining(["kill-session", "-t", "=" + SESSION_PREFIX + "persistent"])
    );
  });

  it("listLiveSessions enumerates by mux (not the engine Map)", async () => {
    const { io, live } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    expect(await host.listLiveSessions()).toEqual(["alice"]);
    // The mux session name carries the prefix.
    expect([...live]).toContain(`${SESSION_PREFIX}alice`);
  });

  it("kill works for an ORPHAN with no engine object (post-restart), by mux name", async () => {
    const { io, live, removedDirs } = makeFakeIo();
    const host = makeHost(io);
    // Simulate a post-restart orphan: a live mux session the host has no engine for.
    live.add(`${SESSION_PREFIX}ghost`);

    await host.kill("ghost"); // no engine in the Map — must kill by canonical name
    expect(live.has(`${SESSION_PREFIX}ghost`)).toBe(false);
    // And the neutral dir is removed (§6.5).
    expect(removedDirs).toContain(`${NEUTRAL_BASE}/ghost`);
  });

  it("kill is idempotent for an absent session", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await expect(host.kill("nobody")).resolves.toBeUndefined();
  });
});

describe("verified submit attempt ledger", () => {
  it("uses the approved 35 second failure-only deadline", () => {
    expect(VERIFIED_SUBMIT_DEADLINE_MS).toBe(35_000);
  });

  it("joins and caches duplicate same-ID/same-payload attempts", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    const verified = vi
      .spyOn(CliChatEngineImpl.prototype, "verifiedSubmit")
      .mockResolvedValue(undefined);
    const attempt = {
      attemptId: "11111111-1111-4111-8111-111111111111",
      text: "private payload"
    };

    await Promise.all([host.submit("alice", attempt), host.submit("alice", attempt)]);
    await host.submit("alice", attempt);

    expect(verified).toHaveBeenCalledTimes(1);
  });

  it("rejects same-ID/different-payload without executing a second submit", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    const verified = vi
      .spyOn(CliChatEngineImpl.prototype, "verifiedSubmit")
      .mockResolvedValue(undefined);
    const attemptId = "22222222-2222-4222-8222-222222222222";

    await host.submit("alice", { attemptId, text: "first" });
    await expect(host.submit("alice", { attemptId, text: "second" })).rejects.toBeInstanceOf(
      BadSubmitAttemptError
    );
    expect(verified).toHaveBeenCalledTimes(1);
  });

  it("cancels an active submit outside the queue and releases a queued kill", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    vi.spyOn(CliChatEngineImpl.prototype, "verifiedSubmit").mockImplementation(
      async ({ signal }) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new VerifiedSubmitError("unavailable")), {
            once: true
          });
        })
    );
    const attempt = {
      attemptId: "33333333-3333-4333-8333-333333333333",
      text: "private payload"
    };

    const submit = host.submit("alice", attempt);
    const kill = host.kill("alice");
    await host.cancelSubmit("alice", { attemptId: attempt.attemptId });

    await expect(submit).rejects.toMatchObject({ code: "unavailable" });
    await expect(kill).resolves.toBeUndefined();
  });

  it("retains a canceled-before-start tombstone and never executes that attempt", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    const verified = vi
      .spyOn(CliChatEngineImpl.prototype, "verifiedSubmit")
      .mockResolvedValue(undefined);
    const attemptId = "44444444-4444-4444-8444-444444444444";

    await host.cancelSubmit("alice", { attemptId });
    await expect(
      host.submit("alice", { attemptId, text: "private payload" })
    ).rejects.toMatchObject({ code: "unavailable" });

    expect(verified).not.toHaveBeenCalled();
  });

  it("bounds synthetic tombstones to a 128 FIFO and never evicts a real submitted attempt", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    await host.launch("alice", launchParams());
    const verified = vi
      .spyOn(CliChatEngineImpl.prototype, "verifiedSubmit")
      .mockResolvedValue(undefined);

    const realAttemptId = "real-attempt-0";
    await host.submit("alice", { attemptId: realAttemptId, text: "real payload" });

    for (let i = 0; i < 129; i++) {
      await host.cancelSubmit("alice", { attemptId: `tombstone-${i}` });
    }

    // Oldest tombstone was evicted: its delayed submit now reaches the engine instead of
    // rejecting "unavailable".
    await expect(
      host.submit("alice", { attemptId: "tombstone-0", text: "late payload" })
    ).resolves.toBeUndefined();

    // Newest tombstone is still within the 128 ceiling: it must still block its delayed submit.
    await expect(
      host.submit("alice", { attemptId: "tombstone-128", text: "late payload" })
    ).rejects.toMatchObject({ code: "unavailable" });

    // The real submitted attempt (created before any cancellation) was never evicted: a
    // duplicate same-ID/same-payload submit still joins the cached promise instead of firing a
    // second verifiedSubmit.
    await host.submit("alice", { attemptId: realAttemptId, text: "real payload" });

    expect(verified).toHaveBeenCalledTimes(2);
  });
});

describe("replay launch attempt ledger", () => {
  it("joins and caches duplicate replay launch frames by replayAttemptId", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    const launch = vi
      .spyOn(CliChatEngineImpl.prototype, "launch")
      .mockResolvedValue({ offset: 42 });
    const params = {
      ...launchParams(),
      replayBatch: "history",
      replayAttemptId: "55555555-5555-4555-8555-555555555555"
    };

    const [first, duplicate] = await Promise.all([
      host.launch("alice", params),
      host.launch("alice", params)
    ]);
    const cached = await host.launch("alice", params);

    expect(first).toEqual({ offset: 42 });
    expect(duplicate).toEqual(first);
    expect(cached).toEqual(first);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects one replayAttemptId reused for different replay text", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    vi.spyOn(CliChatEngineImpl.prototype, "launch").mockResolvedValue({ offset: 42 });
    const replayAttemptId = "66666666-6666-4666-8666-666666666666";

    await host.launch("alice", {
      ...launchParams(),
      replayBatch: "first history",
      replayAttemptId
    });
    await expect(
      host.launch("alice", {
        ...launchParams(),
        replayBatch: "different history",
        replayAttemptId
      })
    ).rejects.toBeInstanceOf(BadSubmitAttemptError);
  });
});

describe("§6.5 startup CLEAN-SLATE sweep", () => {
  it("kills surviving mux sessions AND unconditionally clears the neutral base before launches", async () => {
    const { io, live, removedDirs } = makeFakeIo();
    // Two foreign token dirs persist on the volume; one survives as a mux session too.
    live.add(`${SESSION_PREFIX}stale`);

    // ls on the neutral base lists two persisted sessionKey dirs.
    (io.run as ReturnType<typeof vi.fn>).mockImplementation(
      async (cmd: string, args: readonly string[]) => {
        if (cmd === "tmux") {
          const verb = args[0] === "-S" ? args[2] : args[0];
          if (verb === "list-sessions")
            return { code: 0, stdout: [...live].join("\n"), stderr: "" };
          if (verb === "kill-session") {
            // §4.5 exact-name target `=jarv1s-live-<key>`: strip the leading `=` to match the
            // bare session names held in `live`.
            live.delete(args[args.indexOf("-t") + 1]!.replace(/^=/, ""));
            return { code: 0, stdout: "", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        if (cmd === "ls") {
          // -A on the neutral base → the persisted foreign dirs.
          return { code: 0, stdout: "stale\nother-user\n", stderr: "" };
        }
        if (cmd === "rm") {
          removedDirs.push(args[args.length - 1]!);
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    );

    const host = makeHost(io);
    await host.startupSweep();

    // (a) the surviving mux session was killed.
    expect(live.has(`${SESSION_PREFIX}stale`)).toBe(false);
    // (b) EVERY persisted dir under the base was removed unconditionally (§6.5).
    expect(removedDirs).toContain(`${NEUTRAL_BASE}/stale`);
    expect(removedDirs).toContain(`${NEUTRAL_BASE}/other-user`);
  });

  it("#1081 H1: calls installService.reconcileInstalledProviders() during startupSweep, after the GC sweep and before the login-service sweep", async () => {
    const { io } = makeFakeIo();
    const callOrder: string[] = [];
    // A minimal fake InstallService — the REAL reconcile behavior (drift/no-op/untouched)
    // is already covered by tests/unit/cli-runner-install.test.ts; this test only proves
    // CliChatEngineHost.startupSweep() actually WIRES the call, in the right order relative
    // to the other boot sweeps (#1081 H1 requires it run before the server ever serves a
    // request, so a stale binary can never back a live session).
    const installService = {
      startupSweep: vi.fn().mockImplementation(async () => {
        callOrder.push("install.startupSweep");
      }),
      reconcileInstalledProviders: vi.fn().mockImplementation(async () => {
        callOrder.push("install.reconcile");
      })
    } as unknown as InstallService;
    const loginService = {
      startupSweep: vi.fn().mockImplementation(async () => {
        callOrder.push("login.startupSweep");
      })
    } as unknown as ConstructorParameters<typeof CliChatEngineHost>[0]["loginService"];

    const host = new CliChatEngineHost({
      io,
      neutralBase: NEUTRAL_BASE,
      singleUser: true,
      cliPresent: async () => true,
      launchTimeoutMs: 2_000,
      installService,
      loginService
    });

    await host.startupSweep();

    expect(installService.reconcileInstalledProviders).toHaveBeenCalledTimes(1);
    // Ordering: GC-ish install.startupSweep → drift reconcile (H1) → login-service sweep.
    expect(callOrder).toEqual(["install.startupSweep", "install.reconcile", "login.startupSweep"]);
  });

  it("purges private transcript markers before clearing the neutral base, and leaves the base intact on purge failure", async () => {
    const success = makeBootSweepIo();
    const host = new CliChatEngineHost({
      io: success.io,
      neutralBase: success.neutralBase,
      homeBase: success.homeBase,
      singleUser: true,
      cliPresent: async () => true,
      launchTimeoutMs: 2_000
    });

    await host.startupSweep();

    expect(success.calls).toContain(`rm -f ${success.codexPath}`);
    expect(success.calls).toContain(`rm -rf ${success.geminiChatsDir}`);
    expect(success.calls.indexOf(`rm -f ${success.codexPath}`)).toBeLessThan(
      success.calls.indexOf(`rm -rf ${success.neutralDir}`)
    );
    expect(success.calls.indexOf(`rm -rf ${success.geminiChatsDir}`)).toBeLessThan(
      success.calls.indexOf(`rm -rf ${success.neutralDir}`)
    );

    const failure = makeBootSweepIo({ codexMismatch: true });
    const failedHost = new CliChatEngineHost({
      io: failure.io,
      neutralBase: failure.neutralBase,
      homeBase: failure.homeBase,
      singleUser: true,
      cliPresent: async () => true,
      launchTimeoutMs: 2_000
    });

    await failedHost.startupSweep();

    expect(failure.calls).not.toContain(`rm -rf ${failure.neutralDir}`);
  });

  it("after the sweep clears a foreign token dir, the gate's liveKeys start empty (a launch is admitted)", async () => {
    const { io, live } = makeFakeIo();
    // Pre-sweep: a foreign mux session exists (would otherwise block the gate).
    live.add(`${SESSION_PREFIX}foreign`);
    const host = makeHost(io);

    await host.startupSweep(); // kills the foreign mux session + clears dirs

    // Now a fresh user can launch — the liveKeys set is truthful/empty after the sweep.
    await expect(host.launch("newuser", launchParams())).resolves.toBeDefined();
  });
});

/**
 * A per-name-gated fake TmuxIo: a launch for `gatedName` wedges its `new-session` behind a
 * caller-released promise (modelling a hung/slow tmux past launchTimeoutMs); every other
 * `new-session` proceeds immediately. `kill-session -t =<name>` strips the leading `=`
 * exact-match marker (killMuxSessionByName uses `=name`) before deleting, so kills land on
 * the stored name. Records every killed name so the test can assert the late orphan is reaped.
 */
function makeGatedIo(opts: { gatedName: string; gate: Promise<void> }): {
  io: TmuxIo;
  live: Set<string>;
  killed: string[];
} {
  const live = new Set<string>();
  const killed: string[] = [];
  const completeTranscript = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }
  });
  const strip = (target: string): string => (target.startsWith("=") ? target.slice(1) : target);

  const run = vi.fn(async (cmd: string, args: readonly string[]) => {
    if (cmd === "tmux") {
      const verb = args[0] === "-S" ? args[2] : args[0];
      if (verb === "new-session") {
        const name = args[args.indexOf("-s") + 1]!;
        if (name === opts.gatedName) await opts.gate; // wedge ONLY the gated key
        live.add(name);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "list-sessions") {
        return { code: 0, stdout: [...live].join("\n"), stderr: "" };
      }
      if (verb === "kill-session") {
        const name = strip(args[args.indexOf("-t") + 1]!);
        killed.push(name);
        live.delete(name);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "has-session") {
        const name = strip(args[args.indexOf("-t") + 1]!);
        return { code: live.has(name) ? 0 : 1, stdout: "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    // rm / ls / mkdir / chmod → ok (ls returns "no entries" so the sweep is a no-op here).
    if (cmd === "ls") return { code: 1, stdout: "", stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });

  const io: TmuxIo = {
    run: run as unknown as TmuxIo["run"],
    readFile: vi.fn().mockResolvedValue(completeTranscript),
    writeFile: vi.fn().mockResolvedValue(undefined),
    sleep: vi.fn().mockResolvedValue(undefined)
  };
  return { io, live, killed };
}

describe("UNPROVEN-1: wedged launch past launchTimeoutMs releases the reservation AND reaps the late orphan", () => {
  it("a wedged alice launch times out (unavailable), admits a DIFFERENT bob, then reaps alice's late mux session", async () => {
    let openAlice!: () => void;
    const aliceGate = new Promise<void>((res) => {
      openAlice = res;
    });
    const { io, live, killed } = makeGatedIo({
      gatedName: `${SESSION_PREFIX}alice`,
      gate: aliceGate
    });
    // A short timeout so alice's wedged new-session blows the launch budget quickly.
    const host = new CliChatEngineHost({
      io,
      neutralBase: NEUTRAL_BASE,
      singleUser: true,
      cliPresent: async () => true,
      launchTimeoutMs: 20
    });

    // (1) alice's launch wedges in new-session and times out → unavailable. The reservation
    // for alice MUST be released by the timeout's finally (fail-safe, §4.1.0a) so the gate
    // is not frozen by a hung tmux.
    await expect(host.launch("alice", launchParams())).rejects.toBeInstanceOf(
      CliChatUnavailableError
    );
    // alice is NOT yet live (still wedged) and its reservation is gone.
    expect(live.has(`${SESSION_PREFIX}alice`)).toBe(false);

    // (2) A DIFFERENT user is now admitted — proving the reservation was released, not stranded.
    await expect(host.launch("bob", launchParams())).resolves.toBeDefined();
    expect(live.has(`${SESSION_PREFIX}bob`)).toBe(true);

    // (3) Now alice's wedged new-session completes LATE — it would create jarv1s-live-alice
    // AFTER the timeout already released the reservation. The late-success reaper must kill
    // that orphan immediately (not rely on the startup sweep / api reconcile, §4.1.0a).
    openAlice();
    // Let alice's launchPromise settle and the reaper continuation run.
    await new Promise((r) => setTimeout(r, 20));
    await Promise.resolve();

    expect(killed).toContain(`${SESSION_PREFIX}alice`);
    expect(live.has(`${SESSION_PREFIX}alice`)).toBe(false);
    // bob — the legitimately-admitted session — survives the reap (only alice was reaped).
    expect(live.has(`${SESSION_PREFIX}bob`)).toBe(true);
    expect(host.liveEngineCount()).toBe(1);
  });
});

// ─── §3.2/§4.4 oversize readNew OK → in-band RpcErr{internal}, NOT a close ─────────

const RPC_SECRET = "oversize-test-secret";
const OVERSIZE_BOOT = "boot-oversize";

function hmacClient(nonce: string): string {
  return createHmac("sha256", RPC_SECRET)
    .update(HELLO_PROOF_TAG_CLIENT + nonce)
    .digest("hex");
}

/** A scriptable in-memory ByteChannel that records what the server wrote. */
class FakeChannel implements ByteChannel {
  readonly written: Buffer[] = [];
  closed = false;
  private dataListener?: (chunk: Buffer) => void;
  private closeListener?: () => void;

  write(buf: Buffer): void {
    if (this.closed) return;
    this.written.push(buf);
  }
  end(): void {
    this.closed = true;
    this.closeListener?.();
  }
  on(event: "data" | "close" | "error" | "drain", listener: (chunk: Buffer) => void): void {
    if (event === "data") this.dataListener = listener;
    else if (event === "close" || event === "error") this.closeListener = listener as () => void;
  }
  feed(buf: Buffer): void {
    this.dataListener?.(buf);
  }
  decodeAll(): unknown[] {
    let buf = Buffer.concat(this.written);
    const out: unknown[] = [];
    for (;;) {
      const res = decodeFrame(buf);
      if (res.kind !== "frame") break;
      out.push(JSON.parse(res.body.toString("utf8")));
      buf = buf.subarray(res.consumed);
    }
    return out;
  }
}

/** Drive the client side of the §3.6 handshake against a FakeChannel until authed. */
function authenticate(channel: FakeChannel): void {
  const clientNonce = randomBytes(32).toString("hex");
  channel.feed(encodeFrame({ t: "hello", clientNonce }));
  const challenge = channel
    .decodeAll()
    .find((f) => (f as { t?: string }).t === "hello-challenge") as RpcHelloChallenge;
  channel.feed(
    encodeFrame({ t: "hello-response", clientProof: hmacClient(challenge.serverNonce) })
  );
}

describe("§3.2/§4.4 oversize readNew", () => {
  it("an OK readNew result that would exceed MAX_FRAME_BYTES returns RpcErr{internal} WITHOUT closing", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    // Force readNew to return a single pathological record whose text alone overflows the
    // frame cap — the OK response would not be framable. The server MUST convert this to an
    // in-band RpcErr{internal} rather than letting encodeFrame throw into the close path.
    vi.spyOn(host, "readNew").mockResolvedValue({
      records: [{ kind: "reply", text: "x".repeat(MAX_FRAME_BYTES + 1024) }],
      offset: MAX_FRAME_BYTES + 1024,
      complete: true
    });

    const channel = new FakeChannel();
    // #1059 — ConnectionDeps now requires terminalHost; this suite never exercises the
    // terminal RPC path (see cli-runner-terminal-rpc.test.ts for that), so a plain
    // never-opened instance satisfies the type without adding behavior to these tests.
    const deps: ConnectionDeps = {
      host,
      bootId: OVERSIZE_BOOT,
      secret: RPC_SECRET,
      terminalHost: new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" })
    };
    serveConnection(channel, deps);
    authenticate(channel);

    channel.feed(
      encodeFrame({
        t: "req",
        id: 42,
        method: "readNew",
        sessionKey: "alice",
        params: { afterOffset: 0 }
      })
    );
    await new Promise((r) => setTimeout(r, 10));

    const err = channel.decodeAll().find((f) => (f as RpcErr).id === 42) as RpcErr;
    expect(err).toBeDefined();
    expect(err.t).toBe("err");
    expect(err.error.code).toBe("internal");
    expect(err.bootId).toBe(OVERSIZE_BOOT);
    // The error frame itself is tiny and well under the cap, and the connection survives.
    expect(channel.closed).toBe(false);
  });

  it("threads the decoded frame byte-length into the dispatch log (no longer bytes:0)", async () => {
    const { io } = makeFakeIo();
    const host = makeHost(io);
    vi.spyOn(host, "listLiveSessions").mockResolvedValue([]);

    const logged: Array<{ method?: string; id?: number; bytes: number }> = [];
    const channel = new FakeChannel();
    const deps: ConnectionDeps = {
      host,
      bootId: OVERSIZE_BOOT,
      secret: RPC_SECRET,
      terminalHost: new TerminalHost({ homeBase: "/tmp", toolsBinDir: "/usr/bin" }),
      log: (line) => logged.push(line)
    };
    serveConnection(channel, deps);
    authenticate(channel);

    const reqFrame = encodeFrame({ t: "req", id: 5, method: "listLiveSessions", params: {} });
    channel.feed(reqFrame);
    await new Promise((r) => setTimeout(r, 5));

    const entry = logged.find((l) => l.id === 5);
    expect(entry).toBeDefined();
    // bytes = the JSON payload length (frame minus the 4-byte length prefix), NOT 0.
    expect(entry!.bytes).toBe(reqFrame.length - 4);
    expect(entry!.bytes).toBeGreaterThan(0);
  });
});
