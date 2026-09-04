/**
 * cli-runner LOGIN tests (#342 Phase 3, login-contract §L):
 *   - the LoginService flow: begin → awaiting + allowlisted surface; poll → ready (probe + smoke);
 *     submitToken fed ARGV-FREE (load-buffer→paste-buffer, token never in any run arg); a stale
 *     loginId ⇒ LoginBadRequestError; cancel idempotent; startup sweep kills jarv1s-login-*;
 *   - §L.6.2 surface chokepoint: a non-allowlisted URL is dropped; a userCode is suppressed
 *     post-submit;
 *   - §L.6.3 redactExact: the pasted token is scrubbed from an error message;
 *   - §L.6.1 unified exclusivity gate (engine-host): chat-live ⇒ beginLogin unavailable;
 *     login-in-flight ⇒ launch unavailable; a 2nd beginLogin for the SAME provider (#2232) reuses
 *     the in-flight login, a DIFFERENT provider still gets unavailable;
 *   - §L.1.3 adapter validation: orphan / too-broad-pathPrefix adapters are dropped.
 */
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, beforeEach, vi } from "vitest";

import type { TmuxIo } from "../../packages/ai/src/adapters/tmux-bridge.js";
import { CliChatEngineHost } from "../../packages/cli-runner/src/engine-host.js";
import { LoginService, LoginBadRequestError } from "../../packages/cli-runner/src/login-service.js";
import { LOGIN_ADAPTERS, loadLoginAdapters } from "../../packages/cli-runner/src/login-adapters.js";
import {
  providerTokenPath,
  readProviderToken
} from "../../packages/cli-runner/src/provider-token-store.js";
import { CliChatUnavailableError } from "../../packages/chat/src/live/errors.js";
import { ClaudePersistentRuntimeEngine } from "../../packages/chat/src/live/persistent-runtime-engine.js";
import { createChatEngine } from "../../packages/chat/src/live/engine-selection.js";
import {
  LOGIN_SESSION_PREFIX,
  SESSION_PREFIX,
  listLoginMuxSessionsWithAge
} from "../../packages/chat/src/live/cli-chat-engine.js";
import type { ProbeProviderResult } from "../../packages/chat/src/live/cli-chat-engine.js";
import {
  clearProviderProbeCacheForTests,
  probeProvider
} from "../../packages/chat/src/live/provider-probe.js";
import type { LoginAdapter } from "../../packages/chat/src/live/login-contract.js";
import type {
  CatalogEntry,
  ProviderCatalog
} from "../../packages/chat/src/live/install-contract.js";
import type { RpcProviderKind } from "../../packages/chat/src/live/rpc-contract.js";
import type { ProviderKind } from "../../packages/ai/src/index.js";

/** A controllable probe whose status the test flips between calls. */
function makeProbe(initial: ProbeProviderResult): {
  fn: (p: RpcProviderKind) => Promise<ProbeProviderResult>;
  set: (r: ProbeProviderResult) => void;
} {
  let current = initial;
  return {
    fn: async () => current,
    set: (r) => {
      current = r;
    }
  };
}

/** A fake TmuxIo modelling a live mux-session set + a configurable capture-pane snapshot. */
function makeLoginIo(
  pane = "",
  opts: { newSessionGate?: Promise<void> } = {}
): {
  io: TmuxIo;
  live: Set<string>;
  calls: { cmd: string; args: string[] }[];
  setPane: (p: string) => void;
  /** v0.1.3 reaper: set a session's tmux `session_created` (epoch SECONDS) to control its age. */
  setCreated: (session: string, epochSec: number) => void;
} {
  const live = new Set<string>();
  // v0.1.3 reaper: tmux `session_created` (epoch seconds) per session; defaults to "now".
  const created = new Map<string, number>();
  const calls: { cmd: string; args: string[] }[] = [];
  let paneText = pane;
  const run = vi.fn(async (cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args: [...args] });
    if (cmd === "tmux") {
      const verb = args[0] === "-S" ? args[2] : args[0];
      if (verb === "new-session") {
        // A gate lets a test wedge the session create past the start timeout (§L.3.1 late reap).
        if (opts.newSessionGate) await opts.newSessionGate;
        const session = args[args.indexOf("-s") + 1]!;
        live.add(session);
        if (!created.has(session)) created.set(session, Math.floor(Date.now() / 1000));
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "list-sessions") {
        // v0.1.3: honor the `-F "#{session_name} #{session_created}"` age format used by the
        // reaper; otherwise emit bare names (the existing liveness/sweep format).
        const fmt = args[args.indexOf("-F") + 1] ?? "#{session_name}";
        if (fmt.includes("#{session_created}")) {
          const lines = [...live].map(
            (s) => `${s} ${created.get(s) ?? Math.floor(Date.now() / 1000)}`
          );
          return { code: 0, stdout: lines.join("\n"), stderr: "" };
        }
        return { code: 0, stdout: [...live].join("\n"), stderr: "" };
      }
      if (verb === "kill-session") {
        const session = args[args.indexOf("-t") + 1]!.replace(/^=/, "");
        live.delete(session);
        created.delete(session);
        return { code: 0, stdout: "", stderr: "" };
      }
      if (verb === "capture-pane") {
        return { code: 0, stdout: paneText, stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  return {
    io: {
      run: run as unknown as TmuxIo["run"],
      readFile: vi.fn().mockResolvedValue(""),
      writeFile: vi.fn().mockResolvedValue(undefined),
      sleep: vi.fn().mockResolvedValue(undefined)
    },
    live,
    calls,
    setPane: (p) => {
      paneText = p;
    },
    setCreated: (session, epochSec) => {
      created.set(session, epochSec);
    }
  };
}

let homeBase: string;
beforeEach(async () => {
  homeBase = await mkdtemp(path.join(tmpdir(), "jarv1s-login-test-"));
});

function makeService(
  io: TmuxIo,
  probe: (p: RpcProviderKind) => Promise<ProbeProviderResult>
): LoginService {
  return new LoginService({
    io,
    adapters: LOGIN_ADAPTERS,
    probe,
    homeBase,
    settleMs: 0,
    startTimeoutMs: 5_000,
    loginTimeoutMs: 60_000
  });
}

describe("LoginService flow (§L.2/§L.3)", () => {
  it("begin returns awaiting_token with the allowlisted authorization URL", async () => {
    const f = makeLoginIo("Open https://claude.ai/oauth/authorize?code=abc to continue");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);

    const loginId = svc.reserve("anthropic");
    const out = await svc.start(loginId);

    expect(out.status).toBe("awaiting_token"); // claude adapter mode = paste
    expect(out.authorizationUrl).toBe("https://claude.ai/oauth/authorize?code=abc");
    // Regression (#342 login blocker): pane-target ops (send-keys/capture-pane) must target
    // the exact session WITH a trailing colon (`=<session>:`). On tmux 3.3a a bare
    // `=<session>` is parsed as a pane name → "can't find pane" → login always failed.
    for (const verb of ["send-keys", "capture-pane"]) {
      const call = f.calls.find((c) => c.cmd === "tmux" && c.args.includes(verb));
      expect(call, `expected a tmux ${verb} call`).toBeDefined();
      const target = call!.args[call!.args.indexOf("-t") + 1];
      expect(target).toBe("=jarv1s-login-anthropic:");
    }
    // Regression (#342): the login pane must be WIDE so the provider's authorization URL
    // is not hard-wrapped across lines (which truncated the surfaced URL), and capture-pane
    // must pass -J to rejoin any soft wraps.
    const newSession = f.calls.find((c) => c.cmd === "tmux" && c.args.includes("new-session"));
    const width = Number(newSession!.args[newSession!.args.indexOf("-x") + 1]);
    expect(width).toBeGreaterThanOrEqual(1000);
    const capture = f.calls.find((c) => c.cmd === "tmux" && c.args.includes("capture-pane"));
    expect(capture!.args).toContain("-J");
    expect(await svc.isLoginActive()).toBe(true);
    await svc.cancel("anthropic", loginId);
    expect(await svc.isLoginActive()).toBe(false);
  });

  it("DROPS a non-allowlisted authorization URL (§L.6.2)", async () => {
    const f = makeLoginIo("Visit https://evil.example.com/oauth/authorize?code=x");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    const out = await svc.start(loginId);
    expect(out.authorizationUrl).toBeUndefined();
    await svc.cancel("anthropic", loginId);
  });

  it("surfaces the real claude 2.1.183 setup-token URL (claude.com/cai/oauth)", async () => {
    // Regression (#342): claude 2.1.183 `setup-token` prints a claude.com URL; the original
    // allowlist (claude.ai / console.anthropic.com only) DROPPED it, so login surfaced no URL.
    const realPane =
      "Browser didn't open? Use the url below to sign in (c to copy)\n" +
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code\n" +
      " Paste code here if prompted >";
    const f = makeLoginIo(realPane);
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    const out = await svc.start(loginId);
    expect(out.status).toBe("awaiting_token");
    expect(out.authorizationUrl).toBe(
      "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&response_type=code"
    );
    await svc.cancel("anthropic", loginId);
  });

  it("poll settles ready (probe + runtime smoke) and tears the session down", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(true);

    probe.set({ status: "ready" });
    const out = await svc.poll("anthropic", loginId);
    expect(out.status).toBe("ready");
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(false);
    expect(await svc.isLoginActive()).toBe(false);
  });

  it("submitToken feeds the code ARGV-FREE (load-buffer→paste-buffer) — token in NO run arg (§L.6.3)", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);

    const TOKEN = "PASTED-AUTH-CODE-9f8e7d6c";
    await svc.submitToken("anthropic", loginId, TOKEN);

    // The token was pasted via a tmux BUFFER (load-buffer), never as an argv.
    expect(f.calls.some((c) => c.cmd === "tmux" && c.args.includes("load-buffer"))).toBe(true);
    expect(f.calls.some((c) => c.cmd === "tmux" && c.args.includes("paste-buffer"))).toBe(true);
    for (const call of f.calls) {
      expect(call.args).not.toContain(TOKEN); // NEVER in /proc/cmdline (no send-keys-with-token)
    }
    await svc.cancel("anthropic", loginId);
  });

  it("captures the minted setup-token credential, persists it 0600, and NEVER returns it (#363)", async () => {
    const TOKEN = "sk-ant-oat-CAPTURED1234567890abcdefghijKLMNOP";
    const f = makeLoginIo("https://claude.com/cai/oauth/authorize?code=abc");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);
    // After the paste, the success pane renders the long-lived token.
    f.setPane(
      `✓ Long-lived authentication token created successfully!\n${TOKEN}\nStore this securely.`
    );
    const out = await svc.submitToken("anthropic", loginId, "PASTED-CODE-abc");

    // Persisted 0600 in the token store (claude-scoped).
    expect(await readProviderToken(homeBase, "anthropic")).toBe(TOKEN);
    expect((await stat(providerTokenPath(homeBase, "anthropic"))).mode & 0o777).toBe(0o600);
    // The captured credential NEVER crosses the wire (outcome) nor any tmux argv.
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    for (const call of f.calls) expect(call.args).not.toContain(TOKEN);
    await svc.cancel("anthropic", loginId);
  });

  it("NEVER surfaces a userCode after a submit, even if the pane echoes a code-shaped token (§L.6.2)", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);

    const TOKEN = "PASTEDCODE12345";
    f.setPane(`you typed ${TOKEN} into the prompt`);
    const out = await svc.submitToken("anthropic", loginId, TOKEN);
    expect(out.userCode).toBeUndefined();
    await svc.cancel("anthropic", loginId);
  });

  it("redactExact scrubs the pasted token from an error message (§L.6.3)", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const probe = makeProbe({ status: "needs_login" });
    const svc = makeService(f.io, probe.fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);

    const TOKEN = "BADCODE-abcdef123456";
    probe.set({ status: "error", message: `provider rejected ${TOKEN} as invalid` });
    const out = await svc.submitToken("anthropic", loginId, TOKEN);
    expect(out.status).toBe("error");
    expect(out.message ?? "").not.toContain(TOKEN);
  });

  it("rejects a stale loginId with LoginBadRequestError", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);
    await expect(svc.poll("anthropic", "not-the-id")).rejects.toBeInstanceOf(LoginBadRequestError);
    await svc.cancel("anthropic", loginId);
  });

  it("cancel is idempotent for a non-existent login", async () => {
    const f = makeLoginIo();
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    await expect(svc.cancel("anthropic", "nope")).resolves.toBeUndefined();
  });

  it("short-circuits to ready when the provider is already authenticated", async () => {
    const f = makeLoginIo();
    const svc = makeService(f.io, makeProbe({ status: "ready" }).fn);
    const loginId = svc.reserve("anthropic");
    const out = await svc.start(loginId);
    expect(out.status).toBe("ready");
    expect(await svc.isLoginActive()).toBe(false);
  });

  it("#2232: opens a real login session when the probe says needs_login, even with a saved token file", async () => {
    // A saved token FILE existing is not proof the token still works (an expired token used to
    // read as "ready" forever). start() always asks the probe fresh before deciding whether to
    // short-circuit, so once the probe correctly reports needs_login for an expired token, a
    // fresh login session opens instead of the old short-circuit-to-ready.
    const tokenPath = providerTokenPath(homeBase, "anthropic");
    await mkdir(path.dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, "expired-token-value", { mode: 0o600 });
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");

    const out = await svc.start(loginId);

    expect(out.status).toBe("awaiting_token");
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(true);
    await svc.cancel("anthropic", loginId);
  });

  it("#2242: an expired login after a cached success still opens a fresh login, not a repeat of the saved answer", async () => {
    // This wires the REAL check (the same one settings polling and the login screen both use),
    // saved-answer window and all — a fake that just returns whatever status the test asks for
    // would pass even with the old bug, because it never actually saves or reuses an answer.
    clearProviderProbeCacheForTests();
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    let claudeAnswer: { code: number; stdout: string; stderr?: string } = {
      code: 0,
      stdout: "OK\n"
    };
    const io: TmuxIo = {
      ...f.io,
      run: (async (cmd: string, args: readonly string[], opts?: { env?: NodeJS.ProcessEnv }) => {
        if (cmd === "claude") return claudeAnswer;
        return f.io.run(cmd, args, opts);
      }) as TmuxIo["run"]
    };
    const probe = async (provider: RpcProviderKind, opts?: { readonly forceFresh?: boolean }) =>
      probeProvider(provider as unknown as ProviderKind, {
        io,
        cliPresent: async () => true,
        forceFresh: opts?.forceFresh
      });
    const svc = makeService(io, probe);

    // The login works, and pressing Log in the first time correctly finds it already signed in.
    const firstLoginId = svc.reserve("anthropic");
    const firstOut = await svc.start(firstLoginId);
    expect(firstOut.status).toBe("ready");

    // The login is revoked afterward — a real 401 on the next real call.
    claudeAnswer = { code: 1, stdout: "", stderr: "API Error: 401 invalid bearer token" };

    // A person presses Log in again, inside the window the earlier "ready" answer would still
    // be saved for. This must open a real login, not repeat the saved "ready" answer.
    const secondLoginId = svc.reserve("anthropic");
    const secondOut = await svc.start(secondLoginId);
    expect(secondOut.status).toBe("awaiting_token");
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(true);
    await svc.cancel("anthropic", secondLoginId);
  });

  it("startupSweep kills every jarv1s-login-* session (§L.3.4)", async () => {
    const f = makeLoginIo();
    f.live.add(`${LOGIN_SESSION_PREFIX}anthropic`);
    f.live.add(`${LOGIN_SESSION_PREFIX}openai-compatible`);
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    await svc.startupSweep();
    expect(f.live.size).toBe(0);
  });

  it("rejects beginLogin for a provider with no adapter", async () => {
    // #2027: google now HAS an adapter, so it can no longer stand in for "no adapter". The
    // behaviour under test is the registry-is-the-allowlist rule itself: a provider absent from
    // the registry handed to the service is not loginable. Build such a registry explicitly.
    const f = makeLoginIo();
    const svc = new LoginService({
      io: f.io,
      adapters: { anthropic: LOGIN_ADAPTERS.anthropic! },
      probe: makeProbe({ status: "needs_login" }).fn,
      homeBase: tmpdir()
    });
    expect(svc.hasAdapter("google")).toBe(false);
    expect(() => svc.reserve("google")).toThrow(LoginBadRequestError);
  });
});

describe("Phase-4 Obs 1-A — pasted-code buffer is deleted (token-lifetime gap)", () => {
  it("deletes the tmux paste buffer after submitToken (it outlives the session)", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);

    await svc.submitToken("anthropic", loginId, "PASTED-CODE-abc123");
    const buf = `${LOGIN_SESSION_PREFIX}anthropic`;
    expect(
      f.calls.some(
        (c) => c.cmd === "tmux" && c.args.includes("delete-buffer") && c.args.includes(buf)
      )
    ).toBe(true);
    await svc.cancel("anthropic", loginId);
  });

  it("startupSweep deletes orphaned jarv1s-login-* paste buffers", async () => {
    const f = makeLoginIo();
    const buf = `${LOGIN_SESSION_PREFIX}anthropic`;
    // Model a crash-orphaned buffer (session already gone) by stubbing list-buffers.
    const baseRun = f.io.run;
    f.io.run = (async (cmd: string, args: readonly string[]) => {
      if (cmd === "tmux" && args.includes("list-buffers")) {
        return { code: 0, stdout: `${buf}\nother-buffer`, stderr: "" };
      }
      return baseRun(cmd, args);
    }) as unknown as TmuxIo["run"];

    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    await svc.startupSweep();
    expect(
      f.calls.some(
        (c) => c.cmd === "tmux" && c.args.includes("delete-buffer") && c.args.includes(buf)
      )
    ).toBe(true);
    // The non-login buffer is left alone.
    expect(
      f.calls.some(
        (c) =>
          c.cmd === "tmux" && c.args.includes("delete-buffer") && c.args.includes("other-buffer")
      )
    ).toBe(false);
  });
});

describe("§L.7 #3 acceptance — login gate-release on timeout (5-A/5-B)", () => {
  it("5-A: a start that times out releases the gate AND reaps the late-created session", async () => {
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc", { newSessionGate: gate });
    const svc = new LoginService({
      io: f.io,
      adapters: LOGIN_ADAPTERS,
      probe: makeProbe({ status: "needs_login" }).fn,
      homeBase,
      settleMs: 0,
      startTimeoutMs: 30, // wedge new-session past this
      loginTimeoutMs: 60_000
    });

    const loginId = svc.reserve("anthropic");
    const out = await svc.start(loginId); // times out (new-session is gated)
    expect(out.status).toBe("error");
    expect(await svc.isLoginActive()).toBe(false); // gate released — NOT frozen by the hang

    // The wedged create now settles late and creates the session → the late-reap continuation kills it.
    openGate();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(false);
  });

  it("5-B: the overall login timeout tears the session down and frees the gate", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = new LoginService({
      io: f.io,
      adapters: LOGIN_ADAPTERS,
      probe: makeProbe({ status: "needs_login" }).fn,
      homeBase,
      settleMs: 0,
      startTimeoutMs: 5_000,
      loginTimeoutMs: 40 // short overall lifetime
    });

    const loginId = svc.reserve("anthropic");
    await svc.start(loginId); // awaiting_token; the deadline reaper is armed
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(true);

    await new Promise((r) => setTimeout(r, 90)); // let the deadline fire + teardown run
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(false);
    expect(await svc.isLoginActive()).toBe(false); // gate freed for the next login/chat
  });
});

describe("v0.1.3 max-age login reaper (ADDITIVE — releases the §L.6.1 gate; #347 intact)", () => {
  function makeHost(io: TmuxIo, svc: LoginService): CliChatEngineHost {
    return new CliChatEngineHost({
      io,
      neutralBase: "/data/cli-auth/chat",
      singleUser: true,
      loginService: svc,
      cliPresent: async () => true,
      multiplexerUsable: async () => true
    });
  }

  it("listLoginMuxSessionsWithAge derives age from session_created (epoch seconds)", async () => {
    const f = makeLoginIo();
    f.live.add(`${LOGIN_SESSION_PREFIX}anthropic`);
    const nowMs = 1_000_000_000_000; // fixed
    f.setCreated(`${LOGIN_SESSION_PREFIX}anthropic`, nowMs / 1000 - 120); // created 120s ago
    const ages = await listLoginMuxSessionsWithAge(f.io, nowMs);
    expect(ages).toEqual([{ provider: "anthropic", ageMs: 120_000 }]);
  });

  it("reaps a STALE orphan login session with no in-memory flow → gate released", async () => {
    const f = makeLoginIo();
    // A stranded disk session (e.g. a failed kill left it) — NO in-memory flow exists.
    const session = `${LOGIN_SESSION_PREFIX}anthropic`;
    f.live.add(session);
    f.setCreated(session, Math.floor(Date.now() / 1000) - 3600); // an hour old
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);

    // Before: the disk session makes the gate look busy.
    expect(await svc.isLoginActive()).toBe(true);

    await svc.reapStaleLogins(600_000); // 10-min bound; the session is older
    expect(f.live.has(session)).toBe(false); // killed
    expect(await svc.isLoginActive()).toBe(false); // gate reopened
  });

  it("does NOT reap a FRESH (within-lifetime) login — a legit slow OAuth is protected", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId); // a real in-progress login (created "now")
    expect(await svc.isLoginActive()).toBe(true);

    await svc.reapStaleLogins(600_000); // session age ≈ 0 < bound ⇒ no-op
    expect(f.live.has(`${LOGIN_SESSION_PREFIX}anthropic`)).toBe(true); // still alive
    expect(await svc.isLoginActive()).toBe(true); // still held — not reaped
    await svc.cancel("anthropic", loginId);
  });

  it("a stale flow's in-memory reservation is cleared by the reaper", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("anthropic");
    await svc.start(loginId);
    // Backdate the session past the bound to simulate a hung login.
    f.setCreated(`${LOGIN_SESSION_PREFIX}anthropic`, Math.floor(Date.now() / 1000) - 3600);

    await svc.reapStaleLogins(600_000);
    expect(await svc.isLoginActive()).toBe(false); // flow + disk session both gone
    // A fresh login can now be admitted (slot free).
    const next = svc.reserve("anthropic");
    expect(next).toBeTruthy();
    await svc.cancel("anthropic", next);
  });

  it("#347 NOT weakened: with a FRESH live login, the reaper is a no-op and chat launch STILL blocks", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);

    const begun = await host.beginLogin("anthropic");
    expect(begun.status).toBe("awaiting_token");

    // The reaper runs but the login is within its lifetime ⇒ untouched.
    await host.reapStaleLogins(600_000);
    expect(await svc.isLoginActive()).toBe(true);

    // The single-active admission gate is intact: a concurrent chat launch is STILL rejected.
    await expect(
      host.launch("user-1", { provider: "anthropic", personaText: "p" })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);

    await host.cancelLogin("anthropic", begun.loginId);
  });

  it("host.reapStaleLogins is a no-op when no login service is wired", async () => {
    const f = makeLoginIo();
    const host = new CliChatEngineHost({
      io: f.io,
      neutralBase: "/data/cli-auth/chat",
      singleUser: true,
      cliPresent: async () => true,
      multiplexerUsable: async () => true
    });
    await expect(host.reapStaleLogins()).resolves.toBeUndefined();
  });
});

describe("§L.6.1 unified exclusivity gate (engine-host)", () => {
  function makeHost(io: TmuxIo, svc: LoginService): CliChatEngineHost {
    return new CliChatEngineHost({
      io,
      neutralBase: "/data/cli-auth/chat",
      singleUser: true,
      loginService: svc,
      cliPresent: async () => true,
      multiplexerUsable: async () => true
    });
  }

  it("rejects a chat launch while a login is in flight", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);

    const begun = await host.beginLogin("anthropic");
    expect(begun.status).toBe("awaiting_token");

    await expect(
      host.launch("user-1", { provider: "anthropic", personaText: "p" })
    ).rejects.toBeInstanceOf(CliChatUnavailableError);

    await host.cancelLogin("anthropic", begun.loginId);
  });

  it("#2232: a 2nd beginLogin for the SAME provider reuses the in-flight login instead of failing", async () => {
    // Models the settings dialog's StrictMode double-mount (#2232): two begin requests for the
    // same provider land back to back. The second must see the login the first already started,
    // not "Provider login is currently unavailable."
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);

    const first = await host.beginLogin("anthropic");
    const second = await host.beginLogin("anthropic");

    // Same login, echoed back rather than refused. `poll` re-derives status live, so the second
    // call can legitimately see the flow having progressed a step (e.g. token → authorization) —
    // what matters is it is the SAME flow, not a rejection.
    expect(second.loginId).toBe(first.loginId);
    expect(second.status).not.toBe("error");

    await host.cancelLogin("anthropic", first.loginId);
  });

  it("rejects a 2nd beginLogin for a DIFFERENT provider while a login is in flight", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);

    const begun = await host.beginLogin("anthropic");
    await expect(host.beginLogin("google")).rejects.toBeInstanceOf(CliChatUnavailableError);

    await host.cancelLogin("anthropic", begun.loginId);
  });

  it("rejects beginLogin while a chat session is live", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);
    f.live.add(`${SESSION_PREFIX}user-9`); // a live chat session
    await expect(host.beginLogin("anthropic")).rejects.toBeInstanceOf(CliChatUnavailableError);
  });

  it("rejects beginLogin while a registry-only persistent runtime is live", async () => {
    const f = makeLoginIo("https://claude.ai/oauth/authorize?code=abc");
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const host = makeHost(f.io, svc);
    const persistent = createChatEngine("anthropic", "user-9", f.io, {
      persistentRuntimeEnabled: true
    });
    expect(persistent).toBeInstanceOf(ClaudePersistentRuntimeEngine);
    (host as unknown as { engines: Map<string, unknown> }).engines.set("user-9", persistent);

    await expect(host.beginLogin("anthropic")).rejects.toBeInstanceOf(CliChatUnavailableError);
  });
});

describe("§L.1.3 login-adapter validation", () => {
  const adapter = (provider: RpcProviderKind, pathPrefix = "/oauth"): LoginAdapter => ({
    provider,
    loginArgv: [provider === "anthropic" ? "claude" : "codex", "login"],
    mode: "paste",
    authUrlAllowlist: [{ host: "claude.ai", pathPrefix }],
    userCodePattern: /^[A-Za-z0-9]{6,}$/,
    extractSurface: () => ({})
  });

  const catalogWith = (anthropicStatus: "supported" | "blocked"): ProviderCatalog => {
    const entry = (p: RpcProviderKind, status: "supported" | "blocked"): CatalogEntry =>
      status === "supported"
        ? {
            provider: p,
            status,
            recipe: {
              kind: "npm",
              pkg: p === "anthropic" ? "@anthropic-ai/claude-code" : "@openai/codex",
              version: "1.0.0",
              lockfile: "x",
              binary: p === "anthropic" ? "claude" : "codex",
              selfUpdateDisable: { kind: "env", key: "X", value: "1" }
            }
          }
        : { provider: p, status, blockedReason: "blocked" };
    return {
      anthropic: entry("anthropic", anthropicStatus),
      "openai-compatible": entry("openai-compatible", "supported"),
      google: { provider: "google", status: "blocked", blockedReason: "spike" }
    };
  };

  it("accepts a complete adapter for an install-supported provider", () => {
    const { adapters, issues } = loadLoginAdapters(catalogWith("supported"), {
      anthropic: adapter("anthropic"),
      "openai-compatible": undefined,
      google: undefined
    });
    expect(adapters.anthropic).toBeDefined();
    expect(issues).toHaveLength(0);
  });

  it("DROPS an orphan adapter (provider not install-supported)", () => {
    const { adapters, issues } = loadLoginAdapters(catalogWith("blocked"), {
      anthropic: adapter("anthropic"),
      "openai-compatible": undefined,
      google: undefined
    });
    expect(adapters.anthropic).toBeUndefined();
    expect(issues.some((i) => i.provider === "anthropic")).toBe(true);
  });

  it("DROPS an adapter whose pathPrefix is too broad ('/')", () => {
    const { adapters, issues } = loadLoginAdapters(catalogWith("supported"), {
      anthropic: adapter("anthropic", "/"),
      "openai-compatible": undefined,
      google: undefined
    });
    expect(adapters.anthropic).toBeUndefined();
    expect(issues.some((i) => i.reason.includes("too broad"))).toBe(true);
  });
});

describe("codex device-auth login adapter", () => {
  it("uses --device-auth and poll mode", () => {
    const adapter = LOGIN_ADAPTERS["openai-compatible"];
    expect(adapter).toBeDefined();
    expect(adapter!.loginArgv).toEqual(["codex", "login", "--device-auth"]);
    expect(adapter!.mode).toBe("poll");
  });

  it("extracts the device URL + one-time code from real pane output", () => {
    const adapter = LOGIN_ADAPTERS["openai-compatible"];
    const pane =
      "Follow these steps to sign in with ChatGPT using device code authorization:\n\n" +
      "1. Open this link in your browser and sign in to your account\n" +
      "   https://auth.openai.com/codex/device\n\n" +
      "2. Enter this one-time code (expires in 15 minutes)\n" +
      "   4DUN-GY7Y3\n";
    expect(adapter!.extractSurface(pane)).toEqual({
      authorizationUrl: "https://auth.openai.com/codex/device",
      userCode: "4DUN-GY7Y3"
    });
  });

  it("does NOT treat an incidental word like 'Starting' as the user code", () => {
    const adapter = LOGIN_ADAPTERS["openai-compatible"];
    const pane =
      "Starting device login...\n" +
      "https://auth.openai.com/codex/device\n" +
      "code: 4DUN-GY7Y3\n";
    const surface = adapter!.extractSurface(pane);
    expect(surface.userCode).toBe("4DUN-GY7Y3");
    expect(surface.userCode).not.toBe("Starting");
  });

  it("DROPS a non-allowlisted device URL", () => {
    const adapter = LOGIN_ADAPTERS["openai-compatible"];
    const pane = "https://evil.example.com/codex/device\n" + "4DUN-GY7Y3\n";
    const surface = adapter!.extractSurface(pane);
    expect(surface.authorizationUrl).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #2027 — the google (Gemini CLI) login adapter
// ---------------------------------------------------------------------------

/**
 * The real pane the Gemini CLI 0.57.0 paints when it cannot open a browser: it clears the screen,
 * prints the instruction, a blank line, the Google authorize URL, a blank line, then the
 * "Enter the authorization code:" prompt and waits on the keyboard. (Read out of the published
 * package's `authWithUserCode`; the URL is the google-auth-library authorize endpoint.)
 */
const GEMINI_LOGIN_PANE =
  "Please visit the following URL to authorize the application:\n\n" +
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=681255809395-" +
  "oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F" +
  "localhost%3A45289%2Foauth2callback&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2F" +
  "cloud-platform&code_challenge=abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12&" +
  "code_challenge_method=S256&state=0123456789abcdef0123456789abcdef&access_type=offline\n\n" +
  "Enter the authorization code: ";

const GEMINI_AUTH_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&client_id=681255809395-" +
  "oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com&redirect_uri=http%3A%2F%2F" +
  "localhost%3A45289%2Foauth2callback&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2F" +
  "cloud-platform&code_challenge=abcDEF123_-abcDEF123_-abcDEF123_-abcDEF12&" +
  "code_challenge_method=S256&state=0123456789abcdef0123456789abcdef&access_type=offline";

describe("#2027 google (Gemini CLI) login adapter", () => {
  it("runs the pinned `gemini` command in paste mode", () => {
    const adapter = LOGIN_ADAPTERS.google;
    expect(adapter).toBeDefined();
    // loginArgv[0] MUST equal PROVIDER_CATALOG.google.recipe.binary or §L.1.3 drops the adapter
    // silently — the drop is not logged, so the only symptom is "not loginable" forever.
    expect(adapter!.loginArgv).toEqual(["gemini"]);
    // The flow prints a link and waits for a pasted code ⇒ paste, not poll. It also must NOT
    // carry `--prompt`/`-p`: that makes the CLI non-interactive and it refuses the paste flow.
    expect(adapter!.mode).toBe("paste");
    expect(adapter!.loginArgv).not.toContain("--prompt");
    expect(adapter!.loginArgv).not.toContain("-p");
  });

  it("extracts the Google authorization URL from the real pane output", () => {
    const surface = LOGIN_ADAPTERS.google!.extractSurface(GEMINI_LOGIN_PANE);
    expect(surface.authorizationUrl).toBe(GEMINI_AUTH_URL);
  });

  it("DROPS a look-alike authorization URL on another host", () => {
    const pane =
      "Please visit the following URL to authorize the application:\n\n" +
      "https://accounts.google.evil.example.com/o/oauth2/v2/auth?state=abc\n\n" +
      "Enter the authorization code: ";
    expect(LOGIN_ADAPTERS.google!.extractSurface(pane).authorizationUrl).toBeUndefined();
  });

  it("DROPS a google-hosted URL outside the oauth path prefix", () => {
    const pane = "https://accounts.google.com/ServiceLogin?continue=abc\n";
    expect(LOGIN_ADAPTERS.google!.extractSurface(pane).authorizationUrl).toBeUndefined();
  });

  it("NEVER surfaces an ordinary pane word as a sign-in code (this flow displays none)", () => {
    // The shared USER_CODE_PATTERN matches any 6-128 char word, so reusing it here would show
    // the user "authorize" (or whatever word came first) as if it were their sign-in code.
    const surface = LOGIN_ADAPTERS.google!.extractSurface(GEMINI_LOGIN_PANE);
    expect(surface.userCode).toBeUndefined();
    expect(
      LOGIN_ADAPTERS.google!.extractSurface("PLEASE-VISIT authorize application").userCode
    ).toBeUndefined();
  });

  it("has NO token-capture pattern (the CLI writes its own credential file)", () => {
    // A capture pattern is how claude's minted setup-token is lifted off the pane. Gemini prints
    // no credential, so a pattern here could only ever surface something it should not.
    expect(LOGIN_ADAPTERS.google!.tokenCapturePattern).toBeUndefined();
  });

  it("begin surfaces the Google URL and awaits the pasted code", async () => {
    const f = makeLoginIo(GEMINI_LOGIN_PANE);
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("google");
    const out = await svc.start(loginId);
    expect(out.status).toBe("awaiting_token");
    expect(out.authorizationUrl).toBe(GEMINI_AUTH_URL);
    expect(out.userCode).toBeUndefined();
    await svc.cancel("google", loginId);
  });
});

describe("#2027 google adapter validation against the catalog", () => {
  const googleCatalog = (status: "supported" | "blocked"): ProviderCatalog => ({
    anthropic: { provider: "anthropic", status: "blocked", blockedReason: "n/a here" },
    "openai-compatible": {
      provider: "openai-compatible",
      status: "blocked",
      blockedReason: "n/a here"
    },
    google:
      status === "supported"
        ? {
            provider: "google",
            status,
            recipe: {
              kind: "npm",
              pkg: "@google/gemini-cli",
              version: "0.57.0",
              lockfile: "packages/cli-runner/recipes/google/npm-shrinkwrap.json",
              binary: "gemini",
              selfUpdateDisable: { kind: "config", path: ".gemini/settings.json", content: "{}\n" }
            }
          }
        : { provider: "google", status, blockedReason: "install blocked" }
  });

  it("keeps the google adapter while its catalog entry is installable", () => {
    const { adapters, issues } = loadLoginAdapters(googleCatalog("supported"), {
      anthropic: undefined,
      "openai-compatible": undefined,
      google: LOGIN_ADAPTERS.google
    });
    expect(adapters.google).toBeDefined();
    expect(issues).toHaveLength(0);
  });

  it("DROPS the google adapter while its catalog entry is blocked", () => {
    const { adapters, issues } = loadLoginAdapters(googleCatalog("blocked"), {
      anthropic: undefined,
      "openai-compatible": undefined,
      google: LOGIN_ADAPTERS.google
    });
    expect(adapters.google).toBeUndefined();
    expect(issues.some((i) => i.provider === "google")).toBe(true);
  });
});

describe("#2027 first-run seeding runs before the login session opens", () => {
  it("calls prepareProvider, and calls it BEFORE the CLI is launched", async () => {
    const f = makeLoginIo(GEMINI_LOGIN_PANE);
    const order: string[] = [];
    const svc = new LoginService({
      io: {
        ...f.io,
        run: (async (cmd: string, args: readonly string[]) => {
          const verb = args[0] === "-S" ? args[2] : args[0];
          if (cmd === "tmux" && verb === "new-session") order.push("launch");
          return (f.io.run as unknown as (c: string, a: readonly string[]) => Promise<unknown>)(
            cmd,
            args
          );
        }) as unknown as TmuxIo["run"]
      },
      adapters: { google: LOGIN_ADAPTERS.google! },
      probe: makeProbe({ status: "needs_login" }).fn,
      homeBase,
      // Seeding answers gemini's sign-in-method question. Once the CLI is running it is too late:
      // it has already read its settings and painted the menu, and the authorization URL never
      // prints — a live-only failure no other unit test would catch.
      prepareProvider: async (provider) => {
        order.push(`prepare:${provider}`);
      }
    });

    const loginId = svc.reserve("google");
    await svc.start(loginId);

    expect(order[0]).toBe("prepare:google");
    expect(order).toContain("launch");
    expect(order.indexOf("prepare:google")).toBeLessThan(order.indexOf("launch"));
    await svc.cancel("google", loginId);
  });

  it("still works when no prepareProvider is supplied (existing callers unchanged)", async () => {
    const f = makeLoginIo(GEMINI_LOGIN_PANE);
    const svc = makeService(f.io, makeProbe({ status: "needs_login" }).fn);
    const loginId = svc.reserve("google");
    expect((await svc.start(loginId)).status).toBe("awaiting_token");
    await svc.cancel("google", loginId);
  });
});
