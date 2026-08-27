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

export async function probeProvider(
  provider: ProviderKind,
  deps: {
    readonly io: Pick<TmuxIo, "run">;
    readonly cliPresent: (provider: ProviderKind) => Promise<boolean>;
    readonly multiplexerUsable?: () => Promise<boolean>;
    readonly credentialEnv?: NodeJS.ProcessEnv;
    readonly homeBase?: string;
  }
): Promise<ProbeProviderResult> {
  if (deps.multiplexerUsable && !(await deps.multiplexerUsable())) {
    return { status: "multiplexer_unavailable" };
  }
  try {
    if (!(await deps.cliPresent(provider))) return { status: "not_installed" };
    switch (provider) {
      case "anthropic":
        return await probeClaudeAuth(deps.io, deps.credentialEnv, deps.homeBase);
      case "openai-compatible":
        return await probeCodexAuth(deps.io);
      case "google":
        return await probeGeminiAuth(deps.io);
    }
  } catch {
    return { status: "error" };
  }
}

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
    io.run("claude", ["auth", "status"], env ? { env } : undefined)
  );
  try {
    const parsed = JSON.parse(result.stdout) as { loggedIn?: unknown };
    if (typeof parsed.loggedIn === "boolean") {
      return parsed.loggedIn ? { status: "ready" } : { status: "needs_login" };
    }
  } catch {
    // Not JSON; use exit status and auth text below.
  }
  if (result.code !== 0) {
    return /\b(auth|authentication|authorization|login|sign in)\b/i.test(
      `${result.stdout}\n${result.stderr ?? ""}`
    )
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
  return result.code === 0 && GEMINI_READY_ANSWER_RE.test(result.stdout)
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
const GEMINI_READY_ANSWER_RE = /^[\s"'`*_]*ok(ay)?\b/i;

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
