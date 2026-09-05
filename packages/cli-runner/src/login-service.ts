/**
 * §L.3 LOGIN SERVICE — the login-flow mechanics, entirely inside the cli-runner sidecar.
 *
 * Runs a provider login in a captured `jarv1s-login-<provider>` tmux session (HOME =
 * /data/cli-auth so the cred lands on the auth/home volume), surfaces ONLY the allowlisted
 * authorization URL / user code (§L.6.2), detects completion via `probeProvider` (§4.8
 * reused) + a runtime smoke (§L.9.1), and feeds a pasted code argv-free via
 * `load-buffer`→`paste-buffer` (§L.6.3). It holds AT MOST ONE in-flight login (§L.3.1).
 *
 * Admission (the unified §L.6.1 exclusivity gate — login mutually exclusive with chat +
 * other logins) lives in {@link CliChatEngineHost}, which owns the server-wide admission
 * mutex; it calls {@link reserve} (sync) inside the mutex and {@link start} outside it, and
 * consults {@link isLoginActive} from BOTH the launch gate and the beginLogin gate.
 *
 * Auth material NEVER escapes: the pasted token crosses only via the socket payload, is fed
 * argv-free, is `redactExact`-scrubbed from any error, is never logged/persisted/echoed, and
 * the resulting cred lands only on the auth/home volume (§L.6.3/§L.6.4).
 */

import type { ProviderLoginScope } from "@moss/shared";

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { redactExact, redactSecrets, resolveTmuxSocketPath, type TmuxIo } from "@moss/ai";

import { freshClaudeEnv, publishFreshClaudeToken } from "./fresh-cli-login.js";
import {
  freshGeminiEnv,
  prepareFreshGeminiLogin,
  publishFreshGeminiCredential,
  type validateFreshGeminiCredential
} from "./fresh-gemini-login.js";

import { persistProviderToken } from "./provider-token-store.js";

import {
  killLoginMuxSession,
  listLoginMuxSessions,
  listLoginMuxSessionsWithAge,
  LOGIN_SESSION_PREFIX,
  type LoginAdapter,
  type LoginAdapterRegistry,
  type LoginFlowStatus,
  type LoginSurface,
  type ProbeProviderResult,
  type RpcProviderKind
} from "@moss/chat/live";

/**
 * A blocked/unknown/no-adapter provider, or a stale `loginId` — mapped to RpcErr
 * `bad_request` by connection.ts (does NOT close). Distinct from a failed login FLOW (an
 * RpcOk `{status:"error"}`). Distinct class from `InstallBadRequestError` so the dispatch
 * stays explicit.
 */
export class LoginBadRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginBadRequestError";
  }
}

/** The settled/awaiting shape every verb returns (the engine-host maps it to the wire result). */
export interface LoginFlowOutcome {
  readonly loginId: string;
  readonly status: LoginFlowStatus;
  readonly authorizationUrl?: string;
  readonly userCode?: string;
  readonly message?: string;
}

export interface LoginServiceDeps {
  readonly validateFreshGemini?: typeof validateFreshGeminiCredential;
  readonly validateFreshToken?: (
    home: string,
    token: string,
    signal: AbortSignal
  ) => Promise<boolean>;
  /** The §7.2 sanitized execFile-style runner (HOME=/data/cli-auth ⇒ cred lands on the auth volume). */
  readonly io: TmuxIo;
  /** The validated login-adapter registry (§L.1). A provider absent ⇒ login-blocked. */
  readonly adapters: LoginAdapterRegistry;
  /** Completion signal: the §4.8 provider auth probe (reused; no token, no replay). */
  readonly probe: (provider: RpcProviderKind) => Promise<ProbeProviderResult>;
  /** auth/home base for the 0600 paste temp file (§L.6.3). Default /data/cli-auth. */
  readonly homeBase?: string;
  /** Overall login lifetime bound (§L.3.1). A hung browser round-trip MUST NOT freeze the gate. */
  readonly loginTimeoutMs?: number;
  /** Bound the tmux session start (§L.3.1 late-reap). */
  readonly startTimeoutMs?: number;
  /** Pane settle delay between capture attempts (CLI needs a moment to print the URL). */
  readonly settleMs?: number;
  /** Bound the poll for the authorization URL to appear in the pane (§L.2.2). */
  readonly surfaceTimeoutMs?: number;
  /**
   * (#2027) Seed whatever first-run state a provider's CLI needs BEFORE the login session opens.
   * gemini asks which sign-in method to use on a fresh home dir, and stops there — nothing drives
   * that menu, so the authorization URL never prints and login times out with no surface. Optional
   * so an existing caller (and every existing test) keeps working unchanged.
   */
  readonly prepareProvider?: (provider: RpcProviderKind) => Promise<void>;
}

const DEFAULT_HOME_BASE = "/data/cli-auth";
const DEFAULT_LOGIN_TIMEOUT_MS = 600_000; // 10 min — a human-in-the-loop browser round-trip
const DEFAULT_START_TIMEOUT_MS = 20_000;
const DEFAULT_SETTLE_MS = 1_200;
// The provider CLI prints its authorization URL a few seconds after launch (a server
// round-trip), so a single capture at settleMs races it. Poll up to this bound (#342).
const DEFAULT_SURFACE_TIMEOUT_MS = 12_000;

/** The single in-flight login (§L.3.1). */
interface LoginFlow {
  readonly scope?: ProviderLoginScope;
  readonly home: string;
  readonly abort: AbortController;
  started?: boolean;
  submitting?: boolean;
  readonly provider: RpcProviderKind;
  readonly loginId: string;
  readonly adapter: LoginAdapter;
  /** The in-flight pasted token (paste mode) — held for redactExact + the echo-drop (§L.6.2/§L.6.3). */
  heldToken?: string;
  /** (#363) the long-lived credential captured from the success pane — held for redactExact. SECRET. */
  capturedToken?: string;
  /** True once a token was submitted: poll then NEVER re-surfaces a userCode (§L.6.2 HIGH-2). */
  submitted: boolean;
  /** Overall-lifetime reaper; cleared on settle/cancel. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class LoginService {
  private readonly homeBase: string;
  private readonly loginTimeoutMs: number;
  private readonly startTimeoutMs: number;
  private readonly settleMs: number;
  private readonly surfaceTimeoutMs: number;
  /** §L.3.1 AT MOST ONE in-flight login. */
  private flow: LoginFlow | null = null;

  constructor(private readonly deps: LoginServiceDeps) {
    this.homeBase = deps.homeBase ?? DEFAULT_HOME_BASE;
    this.loginTimeoutMs = deps.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
    this.startTimeoutMs = deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    this.settleMs = deps.settleMs ?? DEFAULT_SETTLE_MS;
    this.surfaceTimeoutMs = deps.surfaceTimeoutMs ?? DEFAULT_SURFACE_TIMEOUT_MS;
  }

  /**
   * Every raw tmux verb this service issues MUST target the same private `-S` socket that
   * `killLoginMuxSession`/`listLoginMuxSessions` reap on for this `homeBase` (#1142/#1143) —
   * otherwise create and reap disagree and login sessions (which carry the OAuth-token paste
   * and captured credential) orphan on the shared default tmux server.
   */
  private withSocket(args: readonly string[], home = this.homeBase): string[] {
    return ["-S", resolveTmuxSocketPath(home), ...args];
  }

  /** True iff `provider` has a login adapter (login-supported, §L.1). */
  hasAdapter(provider: RpcProviderKind): boolean {
    return this.deps.adapters[provider] !== undefined;
  }

  /**
   * §L.6.1: login is active when there is an in-memory flow OR a live `jarv1s-login-*` mux
   * session on disk (the latter guards a late-success orphan / a fast in-place restart — the
   * D13/D14 "don't trust the Map alone" lesson). Consulted under the engine-host admission mutex.
   */
  async isLoginActive(): Promise<boolean> {
    if (this.flow) return true;
    const fresh = await readdir(path.join(this.homeBase, ".jarvis", "fresh-logins")).catch(
      () => []
    );
    if (fresh.length > 0) return true; // Retain admission while fresh-context cleanup is unresolved.
    const live = await listLoginMuxSessions(this.deps.io, this.homeBase).catch(
      () => [] as string[]
    );
    return live.length > 0;
  }

  /**
   * #2232: the loginId of the CURRENT in-memory flow, but only if it is for `provider`. Lets the
   * admission gate reuse a same-provider double begin (e.g. a StrictMode double-mount sending two
   * begin requests back to back) instead of refusing the second one outright. `undefined` when
   * there is no in-memory flow, or the active flow is for a different provider, or the "active"
   * signal is only a disk session with no flow in memory (nothing to reuse).
   */
  activeLoginId(provider: RpcProviderKind, scope?: ProviderLoginScope): string | undefined {
    return this.flow && this.flow.provider === provider && sameLoginScope(this.flow.scope, scope)
      ? this.flow.loginId
      : undefined;
  }

  /**
   * §L.6.1 reserve: SYNCHRONOUSLY claim the single login slot (called inside the admission
   * mutex so a concurrent launch/begin sees it). Returns the minted loginId. Throws
   * LoginBadRequestError if a flow already exists (defensive — the gate should have rejected).
   */
  reserve(provider: RpcProviderKind, scope?: ProviderLoginScope): string {
    const adapter = this.deps.adapters[provider];
    if (!adapter) throw new LoginBadRequestError("provider not loginable");
    if (this.flow) throw new LoginBadRequestError("a login is already in progress");
    const loginId = randomUUID();
    this.flow = {
      provider,
      loginId,
      adapter,
      scope: scope ? { ...scope } : undefined,
      home:
        scope && ["anthropic", "google"].includes(provider)
          ? path.join(this.homeBase, ".jarvis", "fresh-logins", loginId)
          : this.homeBase,
      abort: new AbortController(),
      submitted: false,
      timer: undefined
    };
    return loginId;
  }

  /**
   * §L.2.2 start: launch the login CLI in `jarv1s-login-<provider>`, read the pane, surface the
   * allowlisted URL/code. Called OUTSIDE the admission mutex (the reservation already holds the
   * slot). Bounded by `startTimeoutMs` with a late-success orphan reap (§L.3.1). On any failure
   * the flow is cleared + the session reaped. If already authed (probe ready), returns `ready`.
   */
  async start(loginId: string): Promise<LoginFlowOutcome> {
    const flow = this.requireFlow(loginId);
    const session = `${LOGIN_SESSION_PREFIX}${flow.provider}`;
    try {
      if (this.isFresh(flow)) {
        if (
          flow.provider === "google"
            ? !this.deps.validateFreshGemini
            : !this.deps.validateFreshToken
        )
          throw new Error("Fresh credential validation is unavailable");
        this.armDeadline(flow);
        await mkdir(path.join(flow.home, "config"), { recursive: true, mode: 0o700 });
        await writeFile(path.join(flow.home, "tmux.conf"), "set -g remain-on-exit on\n", {
          mode: 0o600,
          flag: "wx"
        });
        if (flow.provider === "google") await prepareFreshGeminiLogin(flow.home);
        this.assertCurrent(flow);
      }
      // (#2027) First-run seeding BEFORE the session opens: once the CLI is running it is too
      // late — it has already read its settings and painted its menu.
      if (!this.isFresh(flow) && this.deps.prepareProvider)
        await this.deps.prepareProvider(flow.provider);

      // Already authenticated? (a re-login of a ready provider) — short-circuit.
      const pre = this.isFresh(flow)
        ? { status: "needs_login" }
        : await this.deps.probe(flow.provider);
      if (pre.status === "ready") {
        return this.settle(flow, "ready");
      }

      // Open the captured login session + run the login command (no secret in the launch line).
      const launchLine = flow.adapter.loginArgv.join(" ");
      const startPromise = this.openLoginSession(session, launchLine, flow);
      let timedOut = false;
      try {
        await this.withTimeout(startPromise, this.startTimeoutMs, () => {
          timedOut = true;
        });
      } catch (err) {
        // Best-effort kill + LATE-SUCCESS reap (mirrors engine-host launch §L.3.1).
        await killLoginMuxSession(this.deps.io, flow.provider, flow.home).catch(() => undefined);
        if (timedOut) {
          void startPromise
            .then(
              () => true,
              () => false
            )
            .then(async (createdLate) => {
              if (createdLate)
                await killLoginMuxSession(this.deps.io, flow.provider, flow.home).catch(
                  () => undefined
                );
            });
        }
        return this.settle(flow, "error", redactSecrets((err as Error).message));
      }

      this.assertCurrent(flow);
      flow.started = true;
      // Arm the overall-lifetime reaper (a hung browser round-trip MUST NOT freeze the gate).
      this.armDeadline(flow);

      const surface = await this.captureSurfaceUntilUrl(flow);
      const status: LoginFlowStatus =
        flow.adapter.mode === "paste" ? "awaiting_token" : "awaiting_authorization";
      return { loginId: flow.loginId, status, ...surface };
    } catch (err) {
      return this.settle(
        flow,
        "error",
        redactExactFlow(flow, redactSecrets((err as Error).message))
      );
    }
  }

  /** §L.2.3 poll: re-derive status via probe (+ runtime smoke on ready); else refresh the surface. */
  async poll(
    provider: RpcProviderKind,
    loginId: string,
    scope?: ProviderLoginScope
  ): Promise<LoginFlowOutcome> {
    const flow = this.matchFlow(provider, loginId, scope);
    this.extendDeadline(flow);
    return this.deriveStatus(flow);
  }

  /**
   * §L.2.3 submitLoginToken (paste mode): feed the pasted code argv-free via
   * `load-buffer`→`paste-buffer` (§L.6.3), then re-derive status. The token is held for
   * redactExact + the echo-drop, fed via a 0600 temp file removed immediately after.
   */
  async submitToken(
    provider: RpcProviderKind,
    loginId: string,
    token: string,
    scope?: ProviderLoginScope
  ): Promise<LoginFlowOutcome> {
    const flow = this.matchFlow(provider, loginId, scope);
    if (this.isFresh(flow) && (!flow.started || flow.submitting))
      throw new LoginBadRequestError("login is busy");
    flow.submitting = true;
    flow.heldToken = token;
    flow.submitted = true;
    this.extendDeadline(flow);
    const session = `${LOGIN_SESSION_PREFIX}${flow.provider}`;
    let tmpDir: string | undefined;
    try {
      // argv-free paste: write the token to a 0600 temp file, load it into a tmux buffer,
      // paste it into the login pane, then Enter. NEVER send-keys-with-the-token (argv leak).
      tmpDir = await mkdtemp(path.join(flow.home, ".login-"));
      const tokenFile = path.join(tmpDir, "code");
      await writeFile(tokenFile, token, { encoding: "utf8", mode: 0o600 });
      await this.deps.io.run(
        "tmux",
        this.withSocket(["load-buffer", "-b", session, tokenFile], flow.home)
      );
      await this.deps.io.run(
        "tmux",
        this.withSocket(["paste-buffer", "-b", session, "-t", `=${session}:`], flow.home)
      );
      await this.deps.io.sleep(200);
      await this.deps.io.run(
        "tmux",
        this.withSocket(["send-keys", "-t", `=${session}:`, "Enter"], flow.home)
      );
      // Phase-4 Obs 1-A (same-UID token-lifetime gap): `load-buffer -b <name>` placed the pasted
      // code in the tmux SERVER-global buffer set, which SURVIVES killing the login session — a
      // same-UID reader could `show-buffer -b <name>` it afterwards. Delete the named buffer the
      // instant the paste has consumed it so the code does not linger past the paste.
      await this.deleteLoginBuffer(flow.provider, flow.home);
      // #363: token-based providers (claude) PRINT a long-lived credential on success rather
      // than persisting one. Capture it from the success pane + persist it (0600) BEFORE the
      // probe runs, so the credential-injected `auth status` settles the flow `ready`.
      await this.captureAndPersistToken(flow);
      if (this.isFresh(flow)) {
        this.assertCurrent(flow);
        if (flow.provider === "google") {
          // Native OAuth writes files after the pasted-code exchange; tolerate its bounded delay.
          const attempts = Math.max(
            1,
            Math.ceil(this.surfaceTimeoutMs / Math.max(this.settleMs, 200))
          );
          for (let i = 0; i < attempts; i++) {
            await this.deps.io.sleep(this.settleMs);
            this.assertCurrent(flow);
            const credential = await this.deps.validateFreshGemini!(flow.home, flow.abort.signal);
            this.assertCurrent(flow);
            if (!credential) continue;
            await publishFreshGeminiCredential(
              this.homeBase,
              flow.scope!,
              credential,
              () => this.flow === flow && !flow.abort.signal.aborted,
              () => this.commitFreshLogin(flow)
            );
            return this.settle(flow, "ready");
          }
          return this.settle(flow, "error", "Fresh credential validation failed");
        }
        const captured = flow.capturedToken;
        if (
          !captured ||
          !(await this.deps.validateFreshToken!(flow.home, captured, flow.abort.signal))
        ) {
          return this.settle(flow, "error", "Fresh credential validation failed");
        }
        this.assertCurrent(flow);
        await publishFreshClaudeToken(
          this.homeBase,
          flow.scope!,
          captured,
          () => this.flow === flow && !flow.abort.signal.aborted,
          () => this.commitFreshLogin(flow)
        );
        return this.settle(flow, "ready");
      }
      await this.deps.io.sleep(this.settleMs);
      return await this.deriveStatus(flow);
    } catch (err) {
      const msg = redactExactFlow(flow, redactSecrets((err as Error).message));
      return this.settle(flow, "error", msg);
    } finally {
      flow.submitting = false;
      if (tmpDir) await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** §L.2.3 cancel: kill the login session + clear the flow. Idempotent (no match ⇒ ok). */
  async cancel(
    provider: RpcProviderKind,
    loginId: string,
    scope?: ProviderLoginScope
  ): Promise<void> {
    if (this.flow) {
      // A stale or foreign handle must never reap the current provider's session.
      await this.teardown(this.matchFlow(provider, loginId, scope));
      return;
    }
    // Bound handles cannot establish ownership of an orphan after a restart.
    if (scope) return;
    await killLoginMuxSession(this.deps.io, provider, this.homeBase).catch(() => undefined);
  }

  /**
   * §L.3.4 startup sweep: kill every `jarv1s-login-*` mux session before the server accepts
   * connections (a fast in-place restart can leave one while the in-memory flow is gone). No
   * on-disk neutral cleanup — login writes provider config under HOME (the intended cred).
   */
  async startupSweep(): Promise<void> {
    const freshBase = path.join(this.homeBase, ".jarvis", "fresh-logins");
    const homes = await readdir(freshBase, { withFileTypes: true }).catch(() => []);
    for (const entry of homes) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const home = path.join(freshBase, entry.name);
      await killLoginMuxSession(this.deps.io, "anthropic", home).catch(() => undefined);
      await this.cleanupFreshHome(home);
    }
    const live = await listLoginMuxSessions(this.deps.io, this.homeBase).catch(
      () => [] as string[]
    );
    for (const provider of live) {
      await killLoginMuxSession(this.deps.io, provider, this.homeBase).catch(() => undefined);
    }
    // Phase-4 Obs 1-A: also drop any orphaned `jarv1s-login-*` SERVER-global paste buffer (a crash
    // BETWEEN load-buffer and the explicit delete can strand one even when its session is already
    // gone — buffers outlive sessions). Enumerate + delete by the login-name prefix.
    const buffers = await this.deps.io
      .run("tmux", this.withSocket(["list-buffers", "-F", "#{buffer_name}"]))
      .catch(() => ({ code: 1, stdout: "" }));
    if (buffers.code === 0) {
      for (const name of buffers.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.startsWith(LOGIN_SESSION_PREFIX))) {
        await this.deps.io
          .run("tmux", this.withSocket(["delete-buffer", "-b", name]))
          .catch(() => undefined);
      }
    }
    this.flow = null;
  }

  /**
   * v0.1.3 max-age reaper (ADDITIVE defense-in-depth — does NOT change the §L.6.1 admission-gate
   * semantics). The server drives this periodically while running. It kills any live
   * `jarv1s-login-*` mux session older than `maxAgeMs` and, if the in-memory flow matches, clears
   * it. This is a DISK-level BACKSTOP to the per-flow {@link armDeadline} in-memory reaper: a login
   * that hung/was abandoned past its lifetime — or whose session a failed kill stranded — would
   * otherwise keep `isLoginActive()` true (the gate reads disk liveness) and permanently block chat
   * until the next restart. Once the stale session is gone and the flow is cleared, `isLoginActive`
   * naturally returns false and the SAME gate reopens — the single-active admission mutex (login ⟂
   * chat ⟂ other logins) is untouched.
   *
   * `maxAgeMs` defaults to {@link DEFAULT_LOGIN_TIMEOUT_MS} (the overall login lifetime, 10 min),
   * so a legitimate slow OAuth round-trip (open URL, authenticate, paste code) is NEVER reaped —
   * this only fires strictly past the existing lifetime bound. Best-effort: never throws.
   */
  async reapStaleLogins(maxAgeMs: number = this.loginTimeoutMs): Promise<void> {
    const sessions = await listLoginMuxSessionsWithAge(
      this.deps.io,
      undefined,
      this.homeBase
    ).catch(() => [] as { provider: string; ageMs: number }[]);
    for (const { provider, ageMs } of sessions) {
      if (ageMs <= maxAgeMs) continue; // a within-lifetime (possibly active) login — leave it
      // Clear a matching in-memory flow (+ its armed deadline timer) so the slot is freed and the
      // late deadline reaper does not double-teardown.
      if (this.flow && this.flow.provider === provider) {
        if (this.flow.timer) clearTimeout(this.flow.timer);
        this.flow.heldToken = undefined;
        this.flow = null;
      }
      await killLoginMuxSession(this.deps.io, provider, this.homeBase).catch(() => undefined);
      await this.deleteLoginBuffer(provider as RpcProviderKind).catch(() => undefined);
    }
  }

  // ─── internals ──────────────────────────────────────────────────────────────

  /** §L.2.3/§L.9.1: probe → (on ready) runtime smoke → ready/error; else refresh surface. */
  private async deriveStatus(flow: LoginFlow): Promise<LoginFlowOutcome> {
    this.assertCurrent(flow);
    if (this.isFresh(flow)) {
      const surface = flow.started ? await this.captureSurface(flow) : {};
      this.assertCurrent(flow);
      return { loginId: flow.loginId, status: "awaiting_token", ...surface };
    }
    const probe = await this.deps.probe(flow.provider);
    if (probe.status === "ready") {
      // §L.9.1 runtime smoke: a bounded non-interactive re-confirmation that auth actually works
      // (a second clean probe), not merely a printed success line.
      const smoke = await this.deps.probe(flow.provider);
      if (smoke.status === "ready") return this.settle(flow, "ready");
      return this.settle(flow, "error", "login smoke check failed");
    }
    if (probe.status === "error") {
      return this.settle(flow, "error", redactExactFlow(flow, redactSecrets(probe.message)));
    }
    // Still awaiting — refresh the (allowlisted) surface; suppress userCode post-submit (§L.6.2).
    const surface = await this.captureSurface(flow);
    const status: LoginFlowStatus = flow.submitted ? "awaiting_token" : "awaiting_authorization";
    return { loginId: flow.loginId, status, ...surface };
  }

  /** Capture the pane, run the adapter's extractSurface, then apply the §L.6.2 echo/exact guards. */
  /**
   * Poll the login pane until the adapter surfaces an authorization URL, or a bounded number
   * of attempts elapses. The provider CLI prints the URL a few seconds after launch (server
   * round-trip), so the single capture at settleMs raced it and login surfaced no URL (#342).
   * Iteration-based (not wall-clock) so a mocked `io.sleep` keeps tests instant. Returns the
   * LAST surface, so a device-code flow that only ever shows a userCode still surfaces it.
   */
  private async captureSurfaceUntilUrl(flow: LoginFlow): Promise<LoginSurface> {
    const attempts = Math.max(1, Math.ceil(this.surfaceTimeoutMs / Math.max(this.settleMs, 200)));
    let last: LoginSurface = {};
    for (let i = 0; i < attempts; i++) {
      await this.deps.io.sleep(this.settleMs);
      last = await this.captureSurface(flow);
      if (last.authorizationUrl) return last;
    }
    return last;
  }

  /**
   * (#363) Capture the long-lived credential a token-based provider PRINTS on success (claude
   * `setup-token` → `sk-ant-oat…`) and persist it 0600 via the provider-token-store. Polls the
   * pane (bounded, like the URL poll) since the exchange takes a beat. No-op for providers
   * without a `tokenCapturePattern` (codex/gemini persist their own cred). The captured value is
   * a SECRET: held on the flow for `redactExact`, persisted to the cli-auth volume, never returned.
   */
  private async captureAndPersistToken(flow: LoginFlow): Promise<void> {
    const pattern = flow.adapter.tokenCapturePattern;
    if (!pattern) return;
    const session = `${LOGIN_SESSION_PREFIX}${flow.provider}`;
    const attempts = Math.max(1, Math.ceil(this.surfaceTimeoutMs / Math.max(this.settleMs, 200)));
    for (let i = 0; i < attempts; i++) {
      await this.deps.io.sleep(this.settleMs);
      const pane = await this.deps.io
        .run("tmux", this.withSocket(["capture-pane", "-p", "-J", "-t", `=${session}:`], flow.home))
        .catch(() => ({ code: 1, stdout: "" }));
      if (pane.code !== 0) continue;
      const match = pane.stdout.match(pattern);
      if (match) {
        this.assertCurrent(flow);
        if (this.isFresh(flow) && flow.heldToken?.includes(match[0]))
          throw new Error("Fresh credential capture matched pasted input");
        flow.capturedToken = match[0]; // SECRET — for redactExact; never surfaced.
        if (!this.isFresh(flow)) await persistProviderToken(this.homeBase, flow.provider, match[0]);
        return;
      }
    }
  }

  private async captureSurface(flow: LoginFlow): Promise<LoginSurface> {
    const session = `${LOGIN_SESSION_PREFIX}${flow.provider}`;
    // -J joins any soft-wrapped lines (belt-and-suspenders alongside the wide login pane,
    // which prevents the hard-wrap that -J cannot rejoin) so a long URL is captured whole.
    const pane = await this.deps.io
      .run("tmux", this.withSocket(["capture-pane", "-p", "-J", "-t", `=${session}:`], flow.home))
      .catch(() => ({ code: 1, stdout: "" }));
    if (pane.code !== 0) return {};
    const raw = flow.adapter.extractSurface(pane.stdout);
    const out: { authorizationUrl?: string; userCode?: string } = {};
    if (raw.authorizationUrl) {
      out.authorizationUrl = redactExactFlow(flow, raw.authorizationUrl);
    }
    // §L.6.2 HIGH-2: NEVER surface a userCode after a token was submitted (the pasted code is
    // now in the pane), and drop any value byte-equal to the held token.
    if (raw.userCode && !flow.submitted && raw.userCode !== flow.heldToken) {
      out.userCode = raw.userCode;
    }
    return out;
  }

  /** Open the captured login session (detached) + run the login command via send-keys. */
  private async openLoginSession(
    session: string,
    launchLine: string,
    flow: LoginFlow
  ): Promise<void> {
    this.assertCurrent(flow);
    if (this.isFresh(flow)) {
      const env = Object.entries(
        flow.provider === "google" ? freshGeminiEnv(flow.home) : freshClaudeEnv(flow.home)
      ).map(([key, value]) => `${key}=${value}`);
      const created = await this.deps.io.run(
        "tmux",
        this.withSocket(
          [
            "-f",
            path.join(flow.home, "tmux.conf"),
            "new-session",
            "-d",
            "-s",
            session,
            "-x",
            "1000",
            "-y",
            "50",
            "-c",
            flow.home,
            "/usr/bin/env",
            "-i",
            ...env,
            ...flow.adapter.loginArgv
          ],
          flow.home
        )
      );
      if (created.code !== 0) throw new Error("Fresh login session create failed");
      if (this.flow !== flow || flow.abort.signal.aborted) {
        await killLoginMuxSession(this.deps.io, flow.provider, flow.home).catch(() => undefined);
        await this.cleanupFreshHome(flow.home);
        throw new Error("Login is no longer active");
      }
      return;
    }
    // WIDE pane (-x): the provider prints its authorization URL on one line and its TUI
    // HARD-wraps at the pane width — a narrow pane splits the URL across lines (a literal
    // newline mid-URL that capture-pane -J can't rejoin), so the surfaced URL was truncated
    // (#342). 1000 cols comfortably fits an OAuth URL (PKCE + state ≈ 350 chars).
    const created = await this.deps.io.run(
      "tmux",
      this.withSocket(["new-session", "-d", "-s", session, "-x", "1000", "-y", "50"])
    );
    if (created.code !== 0) {
      throw new Error(`login session create failed: ${redactSecrets(created.stderr)}`);
    }
    // The login command carries NO secret (login produces the cred) — send-keys is fine here.
    // Target is `=<session>:` (exact session, its active pane) — the TRAILING COLON is
    // REQUIRED: in a target-pane context (send-keys/paste-buffer/capture-pane) tmux 3.3a
    // parses a bare `=<session>` as a PANE name and fails with "can't find pane", which
    // broke every login. The `:` scopes it to the session so the active pane resolves.
    const sent = await this.deps.io.run(
      "tmux",
      this.withSocket(["send-keys", "-t", `=${session}:`, launchLine, "Enter"])
    );
    if (sent.code !== 0) {
      await killLoginMuxSession(this.deps.io, sessionProvider(session), this.homeBase).catch(
        () => undefined
      );
      throw new Error(`login command send failed: ${redactSecrets(sent.stderr)}`);
    }
  }

  /** Settle the flow to a terminal status, tearing down the session + clearing the slot. */
  private settle(flow: LoginFlow, status: "ready" | "error", message?: string): LoginFlowOutcome {
    void this.teardown(flow);
    const out: LoginFlowOutcome = { loginId: flow.loginId, status };
    return message ? { ...out, message } : out;
  }

  /** Kill the login session, clear the deadline timer + the in-memory flow + the held token. */
  private async teardown(flow: LoginFlow): Promise<void> {
    if (flow.timer) clearTimeout(flow.timer);
    flow.abort.abort();
    flow.heldToken = undefined;
    flow.capturedToken = undefined;
    if (this.flow && this.flow.loginId === flow.loginId) this.flow = null;
    await killLoginMuxSession(this.deps.io, flow.provider, flow.home).catch(() => undefined);
    // Phase-4 Obs 1-A: defensively drop the server-global paste buffer too (it outlives the
    // session) — covers a teardown reached before submitToken's explicit delete (e.g. an error
    // or timeout mid-paste). delete-buffer on an absent buffer is a harmless no-op.
    await this.deleteLoginBuffer(flow.provider, flow.home);
    if (this.isFresh(flow)) await this.cleanupFreshHome(flow.home);
  }

  /** Phase-4 Obs 1-A: remove the `<jarv1s-login-provider>` server-global tmux paste buffer. */
  private async deleteLoginBuffer(provider: RpcProviderKind, home = this.homeBase): Promise<void> {
    const session = `${LOGIN_SESSION_PREFIX}${provider}`;
    await this.deps.io
      .run("tmux", this.withSocket(["delete-buffer", "-b", session], home))
      .catch(() => undefined);
  }

  private armDeadline(flow: LoginFlow): void {
    if (this.isFresh(flow) && flow.timer) return; // A bound login has a hard lifetime, never extended by polling.
    if (flow.timer) clearTimeout(flow.timer);
    flow.timer = setTimeout(() => {
      void this.teardown(flow);
    }, this.loginTimeoutMs);
    // Do not keep the process alive solely for this reaper.
    if (typeof flow.timer.unref === "function") flow.timer.unref();
  }

  private async cleanupFreshHome(home: string): Promise<void> {
    const stopped = await this.deps.io
      .run("tmux", this.withSocket(["kill-server"], home))
      .catch(() => undefined);
    if (
      !stopped ||
      (stopped.code !== 0 &&
        !/no server running|No such file or directory/.test(stopped.stderr ?? ""))
    )
      return;
    await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }

  private isFresh(flow: LoginFlow): boolean {
    return ["anthropic", "google"].includes(flow.provider) && flow.scope !== undefined;
  }

  private commitFreshLogin(flow: LoginFlow): void {
    if (flow.timer) clearTimeout(flow.timer);
    this.flow = null; // Publication is the terminal commit, before asynchronous cleanup.
  }

  private assertCurrent(flow: LoginFlow): void {
    if (this.flow !== flow || flow.abort.signal.aborted)
      throw new LoginBadRequestError("Login is no longer active");
  }

  private extendDeadline(flow: LoginFlow): void {
    this.armDeadline(flow);
  }

  private requireFlow(loginId: string): LoginFlow {
    if (!this.flow || this.flow.loginId !== loginId) {
      throw new LoginBadRequestError("no such login");
    }
    return this.flow;
  }

  private matchFlow(
    provider: RpcProviderKind,
    loginId: string,
    scope?: ProviderLoginScope
  ): LoginFlow {
    if (
      !this.flow ||
      this.flow.provider !== provider ||
      this.flow.loginId !== loginId ||
      !sameLoginScope(this.flow.scope, scope)
    ) {
      throw new LoginBadRequestError("no such login");
    }
    return this.flow;
  }

  private async withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout?.();
            reject(new Error("login session start timed out"));
          }, ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Recover the provider literal from a `jarv1s-login-<provider>` session name. */
function sessionProvider(session: string): string {
  return session.startsWith(LOGIN_SESSION_PREFIX)
    ? session.slice(LOGIN_SESSION_PREFIX.length)
    : session;
}

/**
 * Scrub the flow's secrets (the in-flight pasted code AND the #363 captured long-lived token)
 * exactly from a string before it crosses the wire.
 */
function redactExactFlow(flow: LoginFlow, text: string | undefined): string {
  return redactExact(redactExact(text, flow.heldToken), flow.capturedToken);
}

function sameLoginScope(a?: ProviderLoginScope, b?: ProviderLoginScope): boolean {
  return a?.actorUserId === b?.actorUserId && a?.providerConfigId === b?.providerConfigId;
}
