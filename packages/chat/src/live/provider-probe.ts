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

function credentialFingerprint(credentialEnv?: NodeJS.ProcessEnv): string {
  return credentialEnv?.CLAUDE_CODE_OAUTH_TOKEN ?? "";
}

function probeCacheKey(provider: ProviderKind, credentialEnv?: NodeJS.ProcessEnv): string {
  return `${provider}:${credentialFingerprint(credentialEnv)}`;
}

/**
 * #2242 (round 3): a provider that has been caught refusing its saved sign-in, remembered
 * separately from the saved success above. It has to be separate because the two answers come
 * from different places: only the anthropic readiness check saves a success, while a rejection
 * can be learned by any real request — the model-list call, or a chat message that came back
 * "this sign-in is no good". The rejection is consulted for EVERY provider, including the ones
 * whose readiness check only asks a local tool whether a credential file exists (codex), which
 * would otherwise keep answering "ready" straight after the vendor refused that very credential.
 */
interface LoginRejectionEntry {
  /** The credential that was refused, or null when the caller could not name it. A caller that
   *  cannot name the credential (the chat stream, which never sees the token) rejects whatever
   *  credential the next check uses; a request that really succeeds clears it either way. */
  readonly credential: string | null;
}

/**
 * #2242 (round 3): a refusal does NOT age out. It used to expire with the saved success, five
 * minutes on, which meant simply waiting made an unchanged, still-refused credential read as
 * ready again. Only proof that the vendor now accepts a sign-in retires a refusal.
 */
const loginRejections = new Map<ProviderKind, LoginRejectionEntry>();

function hasLoginRejection(
  provider: ProviderKind,
  credentialEnv: NodeJS.ProcessEnv | undefined
): boolean {
  const entry = loginRejections.get(provider);
  if (!entry) return false;
  return entry.credential === null || entry.credential === credentialFingerprint(credentialEnv);
}

/**
 * #2242 (round 3): does this provider's OWN readiness check prove the saved credential against
 * the vendor? claude runs a real one-shot call and gemini runs a real prompt, so a ready answer
 * from either is proof. Codex's check only asks the local tool whether it is holding a sign-in
 * file — a refused credential passes that just as easily as a good one — so a ready answer from
 * it proves nothing and must never retire a recorded refusal.
 */
function checkProvesCredential(provider: ProviderKind): boolean {
  return provider !== "openai-compatible";
}

/** Test-only: drop every cached probe answer so each test starts from a clean slate. */
export function clearProviderProbeCacheForTests(): void {
  probeCache.clear();
  loginRejections.clear();
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
  // #2242 (round 3): the recorded refusal deliberately SURVIVES this. Pressing Log in used to
  // wipe it, which let the very same refused credential come straight back as ready without the
  // vendor accepting anything new — so pressing Log in could close the sign-in screen instead of
  // opening one. Only a real request the vendor accepts retires a refusal now.
}

/**
 * #2242: the ONE shared way for any real provider request to report "the vendor rejected this
 * login". The readiness check is not the only request that can find out a saved login is dead —
 * the model-list call talks to the same vendor with the same credential, and used to learn it and
 * throw the knowledge away, leaving a saved success in place for up to five more minutes. Every
 * such caller routes here, so the next readiness check reports needs_login instead of replaying
 * the stale success. (The readiness check's own rejection already lands in the same store, by
 * saving its own result.) Keyed by provider + credential, so a fresh login is unaffected.
 */
export function recordProviderLoginRejected(
  provider: ProviderKind,
  credentialEnv?: NodeJS.ProcessEnv
): void {
  loginRejections.set(provider, {
    credential: credentialEnv === undefined ? null : credentialFingerprint(credentialEnv)
  });
  // Drop every saved success for this provider too: the refusal proves the saved answer wrong,
  // and leaving it behind would let it reappear the moment the refusal ages out.
  for (const key of [...probeCache.keys()]) {
    if (key.startsWith(`${provider}:`)) probeCache.delete(key);
  }
}

/**
 * #2242 (round 3): does this text read as "the vendor refused this sign-in", as opposed to any
 * other failure? Shared so the chat stream classifies a failed message exactly the way the
 * readiness check classifies a failed check — one wording list, not two that drift apart.
 */
export function looksLikeLoginRejection(text: string): boolean {
  return CLAUDE_AUTH_FAILURE_RE.test(text);
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
    /**
     * #2242 (round 3): a real request to the vendor with the saved sign-in, for a provider whose
     * own readiness check cannot prove a credential (codex). Supplied by the runner, which can
     * make that request; without it a recorded refusal simply stands. "accepted" is the only
     * answer that retires a refusal — anything else leaves it in place.
     */
    readonly verifyCredential?: () => Promise<"accepted" | "refused" | "unknown">;
  }
): Promise<ProbeProviderResult> {
  if (deps.multiplexerUsable && !(await deps.multiplexerUsable())) {
    return { status: "multiplexer_unavailable" };
  }
  try {
    if (!(await deps.cliPresent(provider))) return { status: "not_installed" };
    const key = probeCacheKey(provider, deps.credentialEnv);
    const now = Date.now();
    // #2242 (round 3): a known refusal is consulted BEFORE any provider's own check, for every
    // provider, and an explicit fresh check no longer waves it away. Codex's check only asks the
    // local tool whether it holds a sign-in file, so letting a forced check skip the refusal made
    // the answer "ready" for the very credential the vendor had just refused. A forced check gets
    // past a refusal only by proving the sign-in for real: claude and gemini do that with their
    // own check below; codex needs the runner's real request, and stays at needs_login without it.
    if (hasLoginRejection(provider, deps.credentialEnv)) {
      if (!deps.forceFresh) return { status: "needs_login" };
      if (!checkProvesCredential(provider)) {
        const verdict = deps.verifyCredential ? await deps.verifyCredential() : "unknown";
        if (verdict !== "accepted") return { status: "needs_login" };
        loginRejections.delete(provider);
      }
    }
    if (provider !== "anthropic") {
      const result =
        provider === "openai-compatible"
          ? await probeCodexAuth(deps.io)
          : await probeGeminiAuth(deps.io);
      // A check that really proves the credential and comes back ready retires the old refusal.
      if (result.status === "ready" && checkProvesCredential(provider)) {
        loginRejections.delete(provider);
      }
      return result;
    }
    if (!deps.forceFresh) {
      const cached = probeCache.get(key);
      if (cached && cached.expiresAt > now) return cached.result;
    }
    const result = await probeClaudeAuth(deps.io, deps.credentialEnv, deps.homeBase);
    if (result.status === "ready") loginRejections.delete(provider);
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
