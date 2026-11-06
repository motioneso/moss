import type { CliChatEngine, CliChatEngineImpl, RpcReadStructuredResult } from "@moss/chat/live";

import type { SubmitAttempt } from "./engine-host-types.js";

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

/**
 * #1525: record a freshly created cancel-before-submit tombstone in the per-session FIFO and evict
 * the oldest ones once it exceeds `max`. Only entries still `digest === null` are evicted; an entry
 * `submit()` has since upgraded to a real digest is no longer a synthetic tombstone and survives.
 */
export function boundSyntheticTombstones(
  order: string[],
  ledger: Map<string, SubmitAttempt>,
  attemptId: string,
  max: number
): void {
  order.push(attemptId);
  while (order.length > max) {
    const oldestId = order.shift() as string;
    const oldest = ledger.get(oldestId);
    if (oldest && oldest.digest === null) ledger.delete(oldestId);
  }
}
