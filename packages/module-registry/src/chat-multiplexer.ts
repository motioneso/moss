import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Kysely } from "kysely";

import { resolveMossEnv, type MossDatabase } from "@moss/db";
import type {
  ChatMultiplexerChoice,
  OnboardingProviderCheckResponse,
  OnboardingProviderKind
} from "@moss/shared";
import {
  cliAvailable,
  createBinaryProbe,
  createRealTmuxIo,
  decideMultiplexer,
  isRootWorkspaceConfigured,
  resolveMultiplexer,
  type MultiplexerKind,
  type MultiplexerSource,
  type TmuxIo
} from "@moss/ai";
import {
  CliChatUnavailableError,
  createRealEngineFactory,
  unavailableEngineFactory,
  type ChatEngineFactory,
  type RpcConnection
} from "@moss/chat";
import type { CliChatEngine, PersistentRuntimeLaunchConfig, ReapReason } from "@moss/chat/live";
import {
  CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY,
  CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
  getRuntimeConfigEntry
} from "@moss/settings";

export interface ChatMultiplexerAvailability {
  readonly tmux: boolean;
  readonly herdr: boolean;
}

/**
 * Allowlist of NON-SECRET instance-config keys readable pre-auth via the raw appDb
 * handle. This bounds the documented exemption (Codex finding #1): only these keys
 * may be read this way, and they must never hold secrets (secrets live in the
 * AES-256-GCM credential store, never in instance_settings).
 */
const PREAUTH_READABLE_SETTING_KEYS = new Set<string>([
  "chat.multiplexer",
  "chat.persistent_runtime.enabled",
  // #1554 task #5 — needed so `readPersistentPoolCap`/`createIdleReapMinutesLiveReader` below can
  // read the Decision 4 registry keys through this same bounded pre-auth exception.
  CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY,
  CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY
]);

/** Cap a host probe so a slow/hung binary lookup degrades to false instead of stalling a request. */
async function boundedProbe(p: Promise<boolean>, ms = 1500): Promise<boolean> {
  return Promise.race([
    p.catch(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))
  ]);
}

/**
 * Live, bounded multiplexer usability for a single kind — reports whether THAT
 * SPECIFIC kind is usable, NOT what `resolveMultiplexer` would pick. Routing
 * per-kind availability through `decideMultiplexer` was wrong: that function
 * honors `JARVIS_MULTIPLEXER` as an env override FIRST (a deploy escape hatch
 * that bypasses the install probe), so with the override pinned to `tmux`
 * (install.sh) BOTH `multiplexerUsable("tmux")` and `multiplexerUsable("herdr")`
 * returned true (#343 — herdr false-positive in Docker).
 *
 * Per-kind availability is therefore direct:
 *   tmux  ⇔ tmux binary present
 *   herdr ⇔ herdr binary present AND a Root workspace is resolvable — via the ONE
 *           shared `isRootWorkspaceConfigured` predicate (@moss/ai/root-workspace)
 *           that `decideMultiplexer` also applies in multiplexer-resolve.ts, so the
 *           two can never disagree (#993). The only host I/O is the synchronous PATH
 * `has(bin)` inside createBinaryProbe, still wrapped so the contract is uniformly
 * bounded. Re-reads PATH each call, so a binary installed after boot is reflected on
 * the next status fetch (no restart needed).
 */
export function makeMultiplexerUsableProbe(
  env: NodeJS.ProcessEnv = process.env
): (kind: "tmux" | "herdr") => Promise<boolean> {
  return (kind) =>
    boundedProbe(
      Promise.resolve().then(() => {
        const probe = createBinaryProbe(env);
        if (kind === "tmux") return probe.has("tmux");
        return probe.has("herdr") && isRootWorkspaceConfigured(env);
      })
    );
}

export interface LiveChatMultiplexerStatus {
  readonly available: ChatMultiplexerAvailability;
  readonly herdrInstalled: boolean;
  readonly active: MultiplexerKind | null;
  readonly activeSource: MultiplexerSource | null;
  readonly envOverride: MultiplexerKind | null;
}

function readEnvOverride(env: NodeJS.ProcessEnv): MultiplexerKind | null {
  const raw = resolveMossEnv(env, "JARVIS_MULTIPLEXER")?.trim().toLowerCase();
  return raw === "tmux" || raw === "herdr" ? raw : null;
}

/** Live host probe for the admin Settings UI — resolved fresh on every request, so an operator's
 * install / env change is reflected on the next fetch (no restart-only snapshot). */
export function makeChatMultiplexerStatusProbe(
  env: NodeJS.ProcessEnv = process.env
): (configured: ChatMultiplexerChoice) => Promise<LiveChatMultiplexerStatus> {
  const usable = makeMultiplexerUsableProbe(env);
  return async (configured) => {
    const binaryProbe = createBinaryProbe(env);
    const [tmux, herdr] = await Promise.all([usable("tmux"), usable("herdr")]);
    let active: MultiplexerKind | null = null;
    let activeSource: MultiplexerSource | null = null;
    try {
      const decision = decideMultiplexer({
        env,
        configured,
        isInstalled: (bin) => binaryProbe.has(bin)
      });
      if (decision.ok) {
        active = decision.kind;
        activeSource = decision.source;
      }
    } catch {
      // decideMultiplexer only throws for an invalid JARVIS_MULTIPLEXER value — a deploy
      // config error. Mirror resolveChatEngineFactory: degrade to "no active multiplexer"
      // rather than 500-ing the admin diagnostics page whose whole job is to surface it.
    }
    return {
      available: { tmux, herdr },
      herdrInstalled: binaryProbe.has("herdr"),
      active,
      activeSource,
      envOverride: readEnvOverride(env)
    };
  };
}

/**
 * Live, bounded provider-CLI presence (presence-only). Re-reads PATH each call on the host-dev path.
 *
 * #342: when the cli-runner socket is configured, the CLIs are NOT in this (api) container — an
 * in-process PATH probe would always be false. So route presence through the cli-runner over the
 * socket via `probeProvider` (§4.8): a status of `not_installed` ⇒ false, any other status (ready /
 * needs_login / multiplexer_unavailable / error) ⇒ the binary IS present (presence is decided by the
 * cli-runner, not the api). Bounded + fail-soft (a socket error degrades to false, like the PATH path).
 */
export function makeCliPresentProbe(
  getConnection?: () => RpcConnection | undefined
): (kind: OnboardingProviderKind) => Promise<boolean> {
  return (kind) => {
    const connection = getConnection?.();
    if (connection) {
      return boundedProbe(
        connection
          .probeProvider({ provider: kind })
          .then((result) => result.status !== "not_installed")
          .catch(() => false)
      );
    }
    return boundedProbe(cliAvailable(kind));
  };
}

const PROVIDER_CHECK_PROMPT = "Reply with exactly OK.";
const PROVIDER_CHECK_PERSONA = "You are running a Moss provider connection check.";
const PROVIDER_CHECK_TIMEOUT_MS = 25_000;
const PROVIDER_CHECK_POLL_MS = 250;
const PROVIDER_PROMPT_ACK_MS = 1_000;

export function makeProviderConnectionCheckProbe(deps: {
  readonly engineFactory: ChatEngineFactory;
  readonly cliPresent: (kind: OnboardingProviderKind) => Promise<boolean>;
  readonly skipInstallCheck?: boolean;
  readonly commandIo?: Pick<TmuxIo, "run">;
  /**
   * #342: when the cli-runner socket is configured, the provider auth/presence check runs INSIDE
   * cli-runner (the CLIs + their auth are not in the api container). Route the whole check through the
   * socket via `probeProvider` (§4.8) — it returns the existing OnboardingProviderCheckResponse shape
   * verbatim, including the transient `multiplexer_unavailable`/`error` statuses. Late-bound (an
   * accessor) so a connection wired AFTER probe construction is still used; resolved per request. The
   * in-process spawn path below is the host-dev fallback (no connection).
   */
  readonly connection?: () => RpcConnection | undefined;
}): (kind: OnboardingProviderKind) => Promise<OnboardingProviderCheckResponse> {
  return async (kind) => {
    const connection = deps.connection?.();
    if (connection) {
      try {
        return await connection.probeProvider({ provider: kind });
      } catch (error) {
        // A socket failure is the in-container analogue of an unreachable multiplexer.
        return error instanceof CliChatUnavailableError
          ? { status: "multiplexer_unavailable" }
          : { status: "error" };
      }
    }

    if (!deps.skipInstallCheck && !(await deps.cliPresent(kind))) {
      return { status: "not_installed" };
    }

    let neutralDir: string | null = null;
    let engine: CliChatEngine | null = null;
    try {
      neutralDir = await mkdtemp(join(tmpdir(), "jarv1s-provider-check-"));
      const personaPath = join(neutralDir, "persona.md");
      await writeFile(personaPath, PROVIDER_CHECK_PERSONA, "utf8");

      if (kind === "anthropic") {
        return await checkAnthropicProviderWithClaudeAuthStatus(
          deps.commandIo ?? createRealTmuxIo()
        );
      }
      if (kind === "openai-compatible") {
        return await checkOpenAiCompatibleProviderWithCodexLoginStatus(
          deps.commandIo ?? createRealTmuxIo()
        );
      }
      if (kind === "google") {
        return await checkGoogleProviderWithOneShotPrompt(deps.commandIo ?? createRealTmuxIo());
      }

      engine = await deps.engineFactory(kind, `onboarding-check-${kind}`);
      await withTimeout(engine.launch({ neutralDir, personaPath }), PROVIDER_CHECK_TIMEOUT_MS);
      await acknowledgeProviderPromptIfNeeded(engine, kind);
      await waitForProviderTranscriptIfNeeded(engine, kind, PROVIDER_CHECK_TIMEOUT_MS);
      await withTimeout(engine.submit(PROVIDER_CHECK_PROMPT), PROVIDER_CHECK_TIMEOUT_MS);

      const ready = await waitForProviderReply(engine, kind, PROVIDER_CHECK_TIMEOUT_MS);
      return ready ? { status: "ready" } : { status: "needs_login" };
    } catch (error) {
      if (error instanceof CliChatUnavailableError) {
        return { status: "multiplexer_unavailable" };
      }
      return { status: "error" };
    } finally {
      if (engine) {
        await engine.kill().catch(() => undefined);
      }
      if (neutralDir) {
        await rm(neutralDir, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

async function checkAnthropicProviderWithClaudeAuthStatus(
  io: Pick<TmuxIo, "run">
): Promise<OnboardingProviderCheckResponse> {
  const result = await withTimeout(io.run("claude", ["auth", "status"]), PROVIDER_CHECK_TIMEOUT_MS);
  if (result.code !== 0) {
    return isAuthenticationOutput(`${result.stdout}\n${result.stderr ?? ""}`)
      ? { status: "needs_login" }
      : { status: "error" };
  }

  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    return parsed.loggedIn === true ? { status: "ready" } : { status: "needs_login" };
  } catch {
    return { status: "error" };
  }
}

async function checkOpenAiCompatibleProviderWithCodexLoginStatus(
  io: Pick<TmuxIo, "run">
): Promise<OnboardingProviderCheckResponse> {
  const result = await withTimeout(io.run("codex", ["login", "status"]), PROVIDER_CHECK_TIMEOUT_MS);
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  if (result.code === 0 && /\blogged in\b/i.test(output)) {
    return { status: "ready" };
  }
  return { status: "needs_login" };
}

/**
 * #2028 — the same readiness check `provider-probe.ts` already uses. The pinned Gemini CLI has no
 * auth subcommand at all, so the old `agy auth status` could only ever fail: it named a command
 * that is never installed AND a subcommand that does not exist. A successful one-shot prompt IS
 * the readiness signal, because answering at all requires working credentials.
 */
async function checkGoogleProviderWithOneShotPrompt(
  io: Pick<TmuxIo, "run">
): Promise<OnboardingProviderCheckResponse> {
  const result = await withTimeout(
    io.run("gemini", ["--prompt", "Reply with exactly OK."]),
    PROVIDER_CHECK_TIMEOUT_MS
  );
  if (result.code === 0 && GEMINI_READY_ANSWER_RE.test(result.stdout)) return { status: "ready" };
  // Same split as the Claude check above: only output that actually talks about signing in counts
  // as "needs login". Anything else that fails is a fault, and calling it a login problem would
  // send the founder round a sign-in loop that cannot fix it.
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  return isAuthenticationOutput(output) ? { status: "needs_login" } : { status: "error" };
}

/**
 * A model told to reply "OK" usually does, but it may add a full stop, quote itself, or wrap the
 * word in emphasis. Kept in step with the same rule in `provider-probe.ts`.
 */
const GEMINI_READY_ANSWER_RE = /^[\s"'`*_]*ok(ay)?\b/i;

async function acknowledgeProviderPromptIfNeeded(
  engine: CliChatEngine,
  kind: OnboardingProviderKind
): Promise<void> {
  if (kind === "anthropic" || kind === "google") return;
  await withTimeout(engine.submit(""), PROVIDER_CHECK_TIMEOUT_MS).catch(() => undefined);
  await sleep(PROVIDER_CHECK_POLL_MS);
}

async function waitForProviderTranscriptIfNeeded(
  engine: CliChatEngine,
  kind: OnboardingProviderKind,
  timeoutMs: number
): Promise<void> {
  if (kind !== "google") return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await engine.readNew(0).catch(() => ({
      records: [],
      offset: 0,
      complete: false
    }));
    if (result.offset > 0 || result.records.length > 0 || result.complete) return;
    await sleep(PROVIDER_CHECK_POLL_MS);
  }
}

async function waitForProviderReply(
  engine: CliChatEngine,
  kind: OnboardingProviderKind,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  let lastAckAt = 0;
  while (Date.now() < deadline) {
    const result = await engine.readNew(offset).catch(() => ({
      records: [],
      offset,
      complete: false
    }));
    offset = result.offset;
    if (result.records.some((record) => isProviderCheckOk(record.text))) {
      return true;
    }
    if (result.records.some((record) => record.kind === "reply")) return true;
    if (result.complete && result.records.some((record) => record.kind === "error")) {
      return false;
    }
    if (kind !== "anthropic" && Date.now() - lastAckAt >= PROVIDER_PROMPT_ACK_MS) {
      lastAckAt = Date.now();
      await engine.submit("").catch(() => undefined);
    }
    await sleep(PROVIDER_CHECK_POLL_MS);
  }
  return false;
}

function isProviderCheckOk(text: string): boolean {
  return text.trim().toUpperCase() === "OK";
}

function isAuthenticationOutput(text: string): boolean {
  return /\b(auth|authentication|authorization|login|sign in)\b/i.test(text);
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider check timed out")), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pre-auth read of the non-secret `chat.multiplexer` instance setting. This is the
 * SAME sanctioned class of access already used by the auth registration gate
 * (packages/auth/src/index.ts `readBooleanSetting` for `registration.enabled`): a
 * raw read as jarvis_app_runtime with NO actor GUC. The instance_settings SELECT
 * policy is USING (true) precisely so boot/pre-auth config reads work (migration
 * 0059_admin_tables_rls.sql), while WRITES stay admin-gated
 * (current_actor_is_admin()). It works on a fresh install with zero users (no actor
 * exists yet), and reads only allowlisted non-secret keys.
 *
 * This is a documented, bounded exception to "DataContextDb only" — see
 * docs/DEVELOPMENT_STANDARDS.md "Pre-auth non-secret instance-config reads" (added
 * by this slice). The admin GET/PUT routes (Task 12) still go through DataContextDb
 * + assertAdminUser; only this boot read bypasses it, and only for the allowlist.
 */
async function readMultiplexerChoice(appDb: Kysely<MossDatabase>): Promise<ChatMultiplexerChoice> {
  const key = "chat.multiplexer";
  if (!PREAUTH_READABLE_SETTING_KEYS.has(key)) {
    throw new Error(`pre-auth instance-setting read not allowed for key "${key}"`);
  }
  const row = await appDb
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  const raw = (row?.value as { value?: unknown } | undefined)?.value;
  return raw === "tmux" || raw === "herdr" ? raw : "auto";
}

/**
 * Pre-auth read of `chat.persistent_runtime.enabled` (#1557 Phase 1 rollout flag) — same
 * bounded exception as {@link readMultiplexerChoice} above, same allowlist. Boolean-string
 * setting; default absent = off (bounded-fallback engine, unchanged behavior).
 */
async function readPersistentRuntimeEnabled(appDb: Kysely<MossDatabase>): Promise<boolean> {
  const key = "chat.persistent_runtime.enabled";
  if (!PREAUTH_READABLE_SETTING_KEYS.has(key)) {
    throw new Error(`pre-auth instance-setting read not allowed for key "${key}"`);
  }
  const row = await appDb
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  const raw = (row?.value as { value?: unknown } | undefined)?.value;
  return raw === "true";
}

/**
 * #1557 Finding 2: `chat.persistent_runtime.enabled` must be able to flip off (drain to
 * bounded-fallback) without an API restart, so the engine factory must re-read it on every
 * new-session launch rather than close over a boot-time snapshot. Same fail-closed-to-`false`
 * posture as the one-time boot read above — a transient read failure degrades to the
 * unchanged bounded-fallback engine, never crashes the turn.
 */
function createPersistentRuntimeEnabledLiveReader(
  appDb: Kysely<MossDatabase>,
  log?: (msg: string) => void
): () => Promise<boolean> {
  return async () => {
    try {
      return await readPersistentRuntimeEnabled(appDb);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log?.(
        `[chat] could not read chat.persistent_runtime.enabled setting (${reason}) — defaulting to off`
      );
      return false;
    }
  };
}

/**
 * #1554 — read of `chat.persistent_pool_cap`. The in-process root reads it once at pool
 * construction (Decision 1); the RPC root re-reads it per launch via
 * {@link createPersistentRuntimeConfigLiveReader}, since its pool outlives any single deploy.
 * Same bounded pre-auth exception as
 * {@link readMultiplexerChoice}. Fail-closed to the registry default (never 0 — a 0 cap would
 * permanently deny every admission) on a missing row, an unparseable value, or a read error.
 */
async function readPersistentPoolCap(appDb: Kysely<MossDatabase>): Promise<number> {
  const key = CHAT_PERSISTENT_POOL_CAP_CONFIG_KEY;
  const registryDefault = Number(getRuntimeConfigEntry(key)?.defaultValue ?? "4");
  if (!PREAUTH_READABLE_SETTING_KEYS.has(key)) {
    throw new Error(`pre-auth instance-setting read not allowed for key "${key}"`);
  }
  const row = await appDb
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  const raw = (row?.value as { value?: unknown } | undefined)?.value;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : registryDefault;
}

/**
 * #1554 task #5 — pre-auth read of `chat.persistent_idle_reap_minutes`. Fail-closed to the
 * registry DEFAULT (30), never 0: a 0-minute threshold would reap every warm child on the very
 * next tick, which is a dangerous failure mode for a read error, unlike
 * `readPersistentRuntimeEnabled`'s fail-closed-to-off (off is always safe).
 */
async function readIdleReapMinutes(appDb: Kysely<MossDatabase>): Promise<number> {
  const key = CHAT_PERSISTENT_IDLE_REAP_MINUTES_CONFIG_KEY;
  const registryDefault = Number(getRuntimeConfigEntry(key)?.defaultValue ?? "30");
  if (!PREAUTH_READABLE_SETTING_KEYS.has(key)) {
    throw new Error(`pre-auth instance-setting read not allowed for key "${key}"`);
  }
  const row = await appDb
    .selectFrom("app.instance_settings")
    .select("value")
    .where("key", "=", key)
    .executeTakeFirst();
  const raw = (row?.value as { value?: unknown } | undefined)?.value;
  const parsed = typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : registryDefault;
}

/**
 * #1554 task #5: `chat.persistent_idle_reap_minutes` must be re-readable live (same
 * flip-without-restart contract as {@link createPersistentRuntimeEnabledLiveReader}) so an
 * operator raising/lowering the idle window takes effect on the timer's next tick, not only at
 * boot. Fail-closed to the registry default (30) on a transient read error — never 0.
 */
function createIdleReapMinutesLiveReader(
  appDb: Kysely<MossDatabase>,
  log?: (msg: string) => void
): () => Promise<number> {
  return async () => {
    try {
      return await readIdleReapMinutes(appDb);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log?.(
        `[chat] could not read chat.persistent_idle_reap_minutes setting (${reason}) — defaulting to 30`
      );
      return 30;
    }
  };
}

/**
 * #1554 — the RPC/containerized topology's live-reload channel. The cli-runner root has no DB
 * access, so the api reads all three persistent-runtime settings here on EVERY launch and ships
 * them inside `RpcLaunchParams` (plan, "Settings & flags": "Values reach the cli-runner root
 * inside RPC launch params (never via child env)"). Each field keeps the same fail-closed posture
 * as its in-process counterpart: enabled → `false`, cap → 4, idle-reap → 30, never 0.
 */
export function createPersistentRuntimeConfigLiveReader(
  appDb: Kysely<MossDatabase>,
  log?: (msg: string) => void
): () => Promise<PersistentRuntimeLaunchConfig> {
  const readEnabled = createPersistentRuntimeEnabledLiveReader(appDb, log);
  const readIdleReap = createIdleReapMinutesLiveReader(appDb, log);
  return async () => {
    const [enabled, poolCap, idleReapMinutes] = await Promise.all([
      readEnabled(),
      readPersistentPoolCap(appDb).catch((err) => {
        const reason = err instanceof Error ? err.message : String(err);
        log?.(
          `[chat] could not read chat.persistent_pool_cap setting (${reason}) — defaulting to 4`
        );
        return 4;
      }),
      readIdleReap()
    ]);
    return { enabled, poolCap, idleReapMinutes };
  };
}

/**
 * Resolve the production chat engine factory at boot: env override > admin setting >
 * auto-detect. On success returns a factory bound to the one shared Multiplexer; if
 * no multiplexer is installed, returns a factory that throws CliChatUnavailableError
 * (→ HTTP 503), and logs a clear warning. Never throws — live chat is disabled, not
 * crashed.
 */
export async function resolveChatEngineFactory(deps: {
  appDb: Kysely<MossDatabase>;
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
  /**
   * #1554 task #6 — closes task #5's documented KNOWN GAP below: the composition root
   * (`module-registry/src/index.ts`) threads its `SessionTokenRegistry.revokeBySessionId` (built
   * inside `registerChatRoutes`'s `wiring` closure, reachable here only via index.ts's late-bound
   * "adopt" seam — `routes.ts`'s `adoptMcpTokenRevoke`) through as this callback, so the pool's
   * idle-reap/LRU-evict sweep revokes the reaped session's MCP token instead of leaving it live
   * with no engine behind it.
   */
  onPersistentReap?: (sessionKey: string, reason: ReapReason) => void;
}): Promise<ChatEngineFactory> {
  const env = deps.env ?? process.env;
  const io = createRealTmuxIo();
  const probe = createBinaryProbe(env);

  // Boot resolution must NEVER crash server readiness (the documented "disabled, not
  // crashed" contract). A failed pre-auth settings read (e.g. the DB is unreachable at
  // boot) degrades to "auto" so liveness/readiness stays independent of this optional
  // subsystem; the real choice is re-read on the next restart once the DB is healthy.
  let configured: ChatMultiplexerChoice;
  try {
    configured = await readMultiplexerChoice(deps.appDb);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log?.(`[chat] could not read chat.multiplexer setting (${reason}) — defaulting to auto`);
    configured = "auto";
  }

  // #1557 Phase 1: same "never crash boot, degrade to off" posture as the multiplexer read
  // above — a failed read leaves persistent-runtime OFF (bounded-fallback engine, unchanged).
  let persistentRuntimeEnabled = false;
  try {
    persistentRuntimeEnabled = await readPersistentRuntimeEnabled(deps.appDb);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log?.(
      `[chat] could not read chat.persistent_runtime.enabled setting (${reason}) — defaulting to off`
    );
  }

  let resolution;
  try {
    resolution = resolveMultiplexer({ io, env, configured, isInstalled: (b) => probe.has(b) });
  } catch (err) {
    // Only thrown for an invalid JARVIS_MULTIPLEXER value — a deploy config error.
    const reason = err instanceof Error ? err.message : String(err);
    deps.log?.(`[chat] live CLI chat disabled — ${reason}`);
    return unavailableEngineFactory(reason);
  }

  if (!resolution.ok) {
    deps.log?.(`[chat] live CLI chat disabled — ${resolution.reason}`);
    return unavailableEngineFactory(resolution.reason);
  }
  deps.log?.(
    `[chat] live CLI chat multiplexer: ${resolution.mux.kind} (source: ${resolution.source})`
  );
  if (persistentRuntimeEnabled) {
    deps.log?.("[chat] persistent provider-runtime adapter: ON (chat.persistent_runtime.enabled)");
  }

  // #1554 task #5 — construct the real warm pool for the in-process (host-dev) topology. Cap is
  // read ONCE here (Decision 1: pool-construction-time value); the idle-reap threshold is a live
  // getter re-read on every timer tick (Decision 3's fresh-read contract), matching
  // `persistentRuntimeEnabled` above.
  const persistentPoolCap = await readPersistentPoolCap(deps.appDb).catch((err) => {
    const reason = err instanceof Error ? err.message : String(err);
    deps.log?.(
      `[chat] could not read chat.persistent_pool_cap setting (${reason}) — defaulting to 4`
    );
    return 4;
  });

  return createRealEngineFactory({
    mux: resolution.mux,
    persistentRuntimeEnabled: createPersistentRuntimeEnabledLiveReader(deps.appDb, deps.log),
    persistentPoolCap,
    readIdleReapMinutes: createIdleReapMinutesLiveReader(deps.appDb, deps.log),
    // #1554 task #6 — closes task #5's KNOWN GAP (see git history / relay-10 handoff for the prior
    // state): forwarded straight from this function's own `onPersistentReap` dep, which
    // `module-registry/src/index.ts` populates via `routes.ts`'s `adoptMcpTokenRevoke` late-bound
    // "adopt" seam (same pattern as `adoptChatRpcConnection`/`adoptDropSessionsForProvider`). The
    // pool's idle-reap/LRU-evict sweep now revokes the reaped session's MCP token, not just the
    // pool slot.
    onPersistentReap: deps.onPersistentReap
  });
}
