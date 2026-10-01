import type { CliChatEngine, CliChatEngineImpl, RpcReadStructuredResult } from "@moss/chat/live";

/**
 * #1350 — does this engine drive a multiplexer pane it can echo-verify a submit against?
 * Only `CliChatEngineImpl` does; the one-shot print engines spawn a fresh process per turn and
 * have no pane to read back, so they take the plain `submit` path.
 */
export function hasVerifiedSubmit(engine: CliChatEngine): engine is CliChatEngineImpl {
  return typeof (engine as Partial<CliChatEngineImpl>).verifiedSubmit === "function";
}

/**
 * Review B4 follow-up — mirrors `hasVerifiedSubmit`'s feature-detect pattern. Only the bounded
 * print engine (`ClaudePrintChatEngine`, built by `createStructuredEngine` whenever
 * `needsStructuredOutput` is set) implements these three methods.
 */
export type StructuredCapableEngine = CliChatEngine & {
  launchStructured(
    opts: Parameters<CliChatEngine["launch"]>[0] & { readonly schema: Record<string, unknown> }
  ): Promise<{ readonly offset: number }>;
  submitStructured(text: string): Promise<void>;
  readStructured(afterOffset: number): Promise<RpcReadStructuredResult>;
};

export function hasStructuredMethods(engine: CliChatEngine): engine is StructuredCapableEngine {
  const e = engine as Partial<StructuredCapableEngine>;
  return (
    typeof e.launchStructured === "function" &&
    typeof e.submitStructured === "function" &&
    typeof e.readStructured === "function"
  );
}

/** Internal marker mapped to RpcErr code "not_launched" by the dispatcher. */
export class NotLaunchedError extends Error {
  constructor() {
    super("no live session for this sessionKey");
    this.name = "NotLaunchedError";
  }
}

export class BadSubmitAttemptError extends Error {
  constructor() {
    super("attemptId was already used with a different payload");
    this.name = "BadSubmitAttemptError";
  }
}
