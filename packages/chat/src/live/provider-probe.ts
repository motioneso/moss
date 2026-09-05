import type { ProviderKind, TmuxIo } from "@moss/ai";

export type ProbeProviderStatus =
  | "ready"
  | "needs_login"
  | "not_installed"
  | "multiplexer_unavailable"
  | "error";

export interface ProbeProviderResult {
  readonly status: ProbeProviderStatus;
  readonly message?: string;
}

const PROBE_TIMEOUT_MS = 25_000;
// #2232: the readiness probe now makes a real one-shot call to prove the saved token still
// works, instead of trusting `claude auth status` (which only checks that a token FILE is
// present, never that it is still valid). A real call costs real time and, for a metered
// provider, real money, so the answer is cached briefly rather than re-checked on every request.
const PROBE_CACHE_TTL_MS = 5 * 60_000;

interface ProbeCacheEntry {
  readonly result: ProbeProviderResult;
  readonly expiresAt: number;
}

/** Keyed by provider + the credential actually used, so a fresh login (a new token) always
 *  misses the cache instead of replaying a stale answer. */
const probeCache = new Map<string, ProbeCacheEntry>();

function probeCacheKey(provider: ProviderKind, credentialEnv?: NodeJS.ProcessEnv): string {
  const token = credentialEnv?.CLAUDE_CODE_OAUTH_TOKEN ?? "";
  return `${provider}:${token}`;
}

/** Test-only: drop every cached probe answer so each test starts from a clean slate. */
export function clearProviderProbeCacheForTests(): void {
  probeCache.clear();
}

/**
 * #2242: forget a saved "the login works" answer for one provider + credential. A caller that
 * has just learned the login is actually broken — a known authentication failure on a real
 * call, or a person explicitly starting a fresh login — uses this so the next check runs for
 * real instead of repeating a saved answer that is now known to be wrong.
 */
export function invalidateProviderProbeCache(
  provider: ProviderKind,
  credentialEnv?: NodeJS.ProcessEnv
): void {
  probeCache.delete(probeCacheKey(provider, credentialEnv));
}

export async function probeProvider(
  provider: ProviderKind,
  deps: {
    readonly io: Pick<TmuxIo, "run">;
    readonly cliPresent: (provider: ProviderKind) => Promise<boolean>;
    readonly multiplexerUsable?: () => Promise<boolean>;
    readonly credentialEnv?: NodeJS.ProcessEnv;
    readonly homeBase?: string;
    /**
     * #2242: skip the saved answer and run the real check now. An explicit re-login must never
     * be told "you're already logged in" on the strength of an old saved answer — if the login
     * was quietly revoked since that answer was saved, trusting it would close the re-login
     * screen without ever giving the person a fresh place to sign in. Also used by the periodic
     * install-state reconciliation so a login that quietly expired is caught on its own, not
     * only when someone happens to press Log in again.
     */
    readonly forceFresh?: boolean;
  }
): Promise<ProbeProviderResult> {
  if (deps.multiplexerUsable && !(await deps.multiplexerUsable())) {
    return { status: "multiplexer_unavailable" };
  }
  try {
    if (!(await deps.cliPresent(provider))) return { status: "not_installed" };
    if (provider !== "anthropic") {
      switch (provider) {
        case "openai-compatible":
          return await probeCodexAuth(deps.io);
        case "google":
          return await probeGeminiAuth(deps.io);
      }
    }
    const key = probeCacheKey(provider, deps.credentialEnv);
    const now = Date.now();
    if (!deps.forceFresh) {
      const cached = probeCache.get(key);
      if (cached && cached.expiresAt > now) return cached.result;
    }
    const result = await probeClaudeAuth(deps.io, deps.credentialEnv, deps.homeBase);
    probeCache.set(key, { result, expiresAt: now + PROBE_CACHE_TTL_MS });
    return result;
  } catch {
    return { status: "error" };
  }
}

/** A stale/revoked token is reported by the CLI as an authentication failure, never as a plain
 *  exit code — match the vendor's own wording so a real 401 is never confused with an unrelated
 *  crash (network blip, bad flag, etc.), which would wrongly send a working login to needs_login. */
const CLAUDE_AUTH_FAILURE_RE =
  /\b(401|invalid bearer token|failed to authenticate|unauthorized)\b/i;

/**
 * #2232: prove the saved token actually works by running the cheapest real call the CLI
 * offers — a one-shot `--print` with a trivial prompt — instead of trusting `claude auth
 * status`, which reports `loggedIn: true` whenever the token env var is merely PRESENT, never
 * checking it against the API. A stale/expired token used to read as logged in forever; now it
 * reads as `needs_login` the moment the real call comes back 401.
 */
async function probeClaudeAuth(
  io: Pick<TmuxIo, "run">,
  credentialEnv?: NodeJS.ProcessEnv,
  homeBase?: string
): Promise<ProbeProviderResult> {
  const env: NodeJS.ProcessEnv | undefined =
    homeBase === undefined && credentialEnv === undefined
      ? undefined
      : { ...(homeBase === undefined ? {} : { HOME: homeBase }), ...credentialEnv };
  const result = await probeWithTimeout(
    io.run("claude", ["--print", "Reply with exactly OK."], env ? { env } : undefined)
  );
  const output = `${result.stdout}\n${result.stderr ?? ""}`;
  if (result.code === 0 && READY_ANSWER_RE.test(result.stdout)) {
    return { status: "ready" };
  }
  if (CLAUDE_AUTH_FAILURE_RE.test(output)) {
    return { status: "needs_login" };
  }
  if (result.code !== 0) {
    return /\b(auth|authentication|authorization|login|sign in)\b/i.test(output)
      ? { status: "needs_login" }
      : { status: "error" };
  }
  return { status: "error" };
}

async function probeCodexAuth(io: Pick<TmuxIo, "run">): Promise<ProbeProviderResult> {
  const result = await probeWithTimeout(io.run("codex", ["login", "status"]));
  return result.code === 0 && /\blogged in\b/i.test(`${result.stdout}\n${result.stderr ?? ""}`)
    ? { status: "ready" }
    : { status: "needs_login" };
}

async function probeGeminiAuth(io: Pick<TmuxIo, "run">): Promise<ProbeProviderResult> {
  // (#2027) `gemini --prompt <text>` is the pinned tool's non-interactive one-shot: it prints the
  // model reply on stdout and exits. The old `agy --print` named a command the pinned recipe does
  // not install AND a flag it does not have, so this probe could never run — and since login only
  // reports success when this probe returns `ready`, a user would finish the whole browser round
  // trip and still be told sign-in failed. There is no dedicated auth-status subcommand, so a
  // successful one-shot IS the readiness signal: it needs working credentials to answer at all.
  const result = await probeWithTimeout(io.run("gemini", ["--prompt", "Reply with exactly OK."]));
  return result.code === 0 && READY_ANSWER_RE.test(result.stdout)
    ? { status: "ready" }
    : { status: "needs_login" };
}

/**
 * A model told to reply "OK" usually does, but it may add a full stop, quote itself, or wrap the
 * word in emphasis. Demanding the exact two characters would read a signed-in tool as signed out,
 * so the answer only has to START with that word, ignoring leading whitespace, quotes and markdown
 * emphasis. It must still be that word: an empty answer, or any other sentence, is not readiness.
 * The tool sends its own chatter to the error stream rather than mixing it into the answer, so
 * there is nothing else on standard output to match against by accident.
 */
const READY_ANSWER_RE = /^[\s"'`*_]*ok(ay)?\b/i;

async function probeWithTimeout<T extends { code: number; stdout: string; stderr?: string }>(
  promise: Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error("provider probe timed out")), PROBE_TIMEOUT_MS);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
